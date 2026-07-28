import { describe, expect, it } from 'vitest';
import {
  batteryStatus,
  deciKelvinToC,
  numOrNull,
  parseGpuCsv,
  parseLhmCpu,
  parseLhmJson,
  parseWinProbe,
  toGB,
} from './pcstats';

// The shape LibreHardwareMonitor's /data.json serves: a tree whose leaf values
// are display strings. Current LHM ships no WMI provider, so this HTTP feed is
// the only way an unelevated app can read the CPU package sensor.
const lhmTree = (cpuChildren: unknown[]): string =>
  JSON.stringify({
    Text: 'Sensor',
    Children: [
      {
        Text: 'DAN',
        Children: [
          {
            Text: 'Intel Core i7-9750H',
            Children: [{ Text: 'Temperatures', Children: cpuChildren }],
          },
          {
            // a non-CPU branch that must NOT be mistaken for the CPU
            Text: 'NVIDIA GeForce RTX 2070 with Max-Q Design',
            Children: [
              { Text: 'Temperatures', Children: [{ Text: 'GPU Core', Value: '57.0 °C' }] },
            ],
          },
        ],
      },
    ],
  });

// Captured verbatim from this machine:
//   nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,utilization.memory,
//     memory.used,memory.total,power.draw,power.limit,clocks.sm,fan.speed
//     --format=csv,noheader,nounits
// Note the real "[N/A]" placeholders for power.limit and fan.speed on this card.
const REAL_GPU_LINE =
  'NVIDIA GeForce RTX 2070 with Max-Q Design, 58, 4, 1, 1347, 8192, 27.84, [N/A], 1140, [N/A]';

describe('numOrNull', () => {
  it('parses plain and decimal numbers', () => {
    expect(numOrNull('58')).toBe(58);
    expect(numOrNull(' 27.84 ')).toBe(27.84);
    expect(numOrNull('0')).toBe(0);
  });

  it('maps nvidia-smi bracketed placeholders to null, not NaN', () => {
    expect(numOrNull('[N/A]')).toBeNull();
    expect(numOrNull('[Not Supported]')).toBeNull();
    expect(numOrNull('N/A')).toBeNull();
    expect(numOrNull('')).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
  });
});

describe('parseGpuCsv', () => {
  it('parses a real nvidia-smi line, nulling unsupported fields', () => {
    const [g] = parseGpuCsv(REAL_GPU_LINE);
    expect(g.name).toBe('NVIDIA GeForce RTX 2070 with Max-Q Design');
    expect(g.tempC).toBe(58);
    expect(g.utilPct).toBe(4);
    expect(g.memUtilPct).toBe(1);
    expect(g.memUsedMB).toBe(1347);
    expect(g.memTotalMB).toBe(8192);
    expect(g.powerW).toBe(27.84);
    expect(g.clockMHz).toBe(1140);
    // unsupported on this card — must be null so the UI can show "n/a"
    expect(g.powerLimitW).toBeNull();
    expect(g.fanPct).toBeNull();
  });

  it('parses one entry per GPU and ignores blank lines', () => {
    const out = parseGpuCsv(`${REAL_GPU_LINE}\r\n${REAL_GPU_LINE}\r\n\r\n`);
    expect(out).toHaveLength(2);
  });

  it('keeps numeric columns aligned when the model name contains a comma', () => {
    const [g] = parseGpuCsv('Weird GPU, Inc. Model X, 61, 12, 3, 2048, 16384, 40, 80, 1500, 55');
    expect(g.name).toBe('Weird GPU, Inc. Model X');
    expect(g.tempC).toBe(61);
    expect(g.memTotalMB).toBe(16384);
    expect(g.fanPct).toBe(55);
  });

  it('skips malformed lines rather than emitting a half-filled GPU', () => {
    expect(parseGpuCsv('nvidia-smi: command failed')).toEqual([]);
  });
});

describe('deciKelvinToC', () => {
  it('converts an ACPI tenths-of-Kelvin reading to celsius', () => {
    // 3032 dK = 303.2 K = 30.05 °C
    expect(deciKelvinToC('3032')).toBe(30.1);
    expect(deciKelvinToC('3312')).toBe(58.1);
  });

  it('returns null for the absent reading this machine actually produces', () => {
    // The ACPI thermal zone is unsupported here: the probe emits "TEMP " with
    // an empty value and no error. That must read as "no sensor", not 0 °C.
    expect(deciKelvinToC('')).toBeNull();
    expect(deciKelvinToC(undefined)).toBeNull();
    expect(deciKelvinToC('0')).toBeNull();
  });

  it('rejects physically impossible readings', () => {
    expect(deciKelvinToC('1')).toBeNull(); // -273 °C
    expect(deciKelvinToC('99999')).toBeNull(); // ~9726 °C
  });
});

describe('batteryStatus', () => {
  it('maps the documented CIM_Battery codes', () => {
    expect(batteryStatus(1)).toEqual({ charging: false, label: 'discharging' });
    // 2 = "system has access to AC ... not necessarily charging"
    expect(batteryStatus(2)).toEqual({ charging: true, label: 'on AC' });
    expect(batteryStatus(3)).toEqual({ charging: true, label: 'fully charged' });
    expect(batteryStatus(5)).toEqual({ charging: false, label: 'critical' });
    expect(batteryStatus(6)).toEqual({ charging: true, label: 'charging' });
    expect(batteryStatus(11)).toEqual({ charging: false, label: 'partially charged' });
  });

  it('falls back to unknown for undefined/out-of-range codes', () => {
    expect(batteryStatus(10).label).toBe('unknown');
    expect(batteryStatus(null).label).toBe('unknown');
    expect(batteryStatus(99).label).toBe('unknown');
  });
});

describe('parseWinProbe', () => {
  it('parses the real probe output from this machine', () => {
    // battery present; no hardware monitor running AND no ACPI thermal zone →
    // both temperature lines come back empty
    const probe = parseWinProbe('BATT 88,2\r\nCPUTEMP \r\nTEMP \r\n');
    expect(probe.battery).toEqual({ percent: 88, code: 2 });
    expect(probe.cpuTempC).toBeNull();
    expect(probe.cpuTempSource).toBeNull();
  });

  it('takes the hardware-monitor reading — the same sensor iCUE shows', () => {
    // LibreHardwareMonitor reports plain celsius for "CPU Package"
    const probe = parseWinProbe('BATT 88,2\r\nCPUTEMP 66.00\r\nTEMP \r\n');
    expect(probe.cpuTempC).toBe(66);
    expect(probe.cpuTempSource).toBe('hwmonitor-wmi');
  });

  it('prefers the hardware monitor over the coarse ACPI zone', () => {
    const probe = parseWinProbe('BATT 88,2\r\nCPUTEMP 66.00\r\nTEMP 3312\r\n');
    expect(probe.cpuTempC).toBe(66); // not 58.1
    expect(probe.cpuTempSource).toBe('hwmonitor-wmi');
  });

  it('falls back to the thermal zone when no hardware monitor is running', () => {
    const probe = parseWinProbe('BATT 50,1\r\nCPUTEMP \r\nTEMP 3312\r\n');
    expect(probe.battery).toEqual({ percent: 50, code: 1 });
    expect(probe.cpuTempC).toBe(58.1);
    expect(probe.cpuTempSource).toBe('acpi');
  });

  it('rejects an out-of-range hardware-monitor value', () => {
    const probe = parseWinProbe('BATT 50,1\r\nCPUTEMP 999\r\nTEMP \r\n');
    expect(probe.cpuTempC).toBeNull();
    expect(probe.cpuTempSource).toBeNull();
  });

  it('handles a desktop with no battery', () => {
    const probe = parseWinProbe('BATT none\r\nCPUTEMP \r\nTEMP 3032\r\n');
    expect(probe.battery).toBeNull();
    expect(probe.cpuTempC).toBe(30.1);
  });

  it('returns all-null on empty output rather than throwing', () => {
    expect(parseWinProbe('')).toEqual({
      battery: null,
      cpuTempC: null,
      cpuTempSource: null,
      tjMaxC: null,
      physicalCores: null,
    });
  });

  it('reads the physical core count', () => {
    expect(parseWinProbe('CORES 6\r\nBATT 88,2\r\n').physicalCores).toBe(6);
    // absent / nonsense values stay null rather than becoming 0
    expect(parseWinProbe('CORES \r\n').physicalCores).toBeNull();
    expect(parseWinProbe('CORES 0\r\n').physicalCores).toBeNull();
  });
});

describe('parseLhmJson', () => {
  it('picks the CPU package sensor — the number iCUE shows', () => {
    const json = lhmTree([
      { Text: 'CPU Core #1', Value: '61.0 °C' },
      { Text: 'CPU Core #2', Value: '58.0 °C' },
      { Text: 'CPU Package', Value: '66.0 °C' },
    ]);
    expect(parseLhmJson(json)).toBe(66);
  });

  it('never mistakes the GPU branch for the CPU', () => {
    // no CPU package/core sensors at all → must not fall back to the GPU's 57°C
    expect(parseLhmJson(lhmTree([]))).toBeNull();
  });

  it('falls back to the hottest core when no package sensor exists', () => {
    const json = lhmTree([
      { Text: 'CPU Core #1', Value: '61.0 °C' },
      { Text: 'CPU Core #2', Value: '64.0 °C' },
    ]);
    expect(parseLhmJson(json)).toBe(64);
  });

  it('ignores non-temperature values and derived core aggregates', () => {
    const json = lhmTree([
      { Text: 'CPU Core #1', Value: '1200 MHz' },
      { Text: 'CPU Core Max', Value: '99.0 °C' },
      { Text: 'CPU Core #2', Value: '55.0 °C' },
    ]);
    expect(parseLhmJson(json)).toBe(55);
  });

  it('handles a comma decimal separator', () => {
    expect(parseLhmJson(lhmTree([{ Text: 'CPU Package', Value: '66,5 °C' }]))).toBe(66.5);
  });

  it('returns null on malformed or empty payloads rather than throwing', () => {
    expect(parseLhmJson('')).toBeNull();
    expect(parseLhmJson('not json')).toBeNull();
    expect(parseLhmJson('{}')).toBeNull();
  });

  // Sensor names captured verbatim from this machine's live /data.json.
  const REAL_CPU_SENSORS = [
    { Text: 'Core Max', Value: '88.0 °C' },
    { Text: 'Core Average', Value: '78.2 °C' },
    { Text: 'CPU Core #1', Value: '88.0 °C' },
    { Text: 'CPU Core #2', Value: '70.0 °C' },
    { Text: 'CPU Package', Value: '87.0 °C' },
    // headroom deltas, NOT temperatures — reading these as the CPU temp would
    // report ~12 °C on a CPU actually running at 87 °C
    { Text: 'CPU Core #1 Distance to TjMax', Value: '12.0 °C' },
    { Text: 'CPU Core #2 Distance to TjMax', Value: '30.0 °C' },
  ];

  it('reads the real sensor set from this machine as the package temp', () => {
    expect(parseLhmJson(lhmTree(REAL_CPU_SENSORS))).toBe(87);
  });

  it('derives Tj max from core temp + distance to TjMax', () => {
    // 88 + 12 = 100 — the real Tj max of an i7-9750H, read rather than assumed.
    const { tempC, tjMaxC } = parseLhmCpu(lhmTree(REAL_CPU_SENSORS));
    expect(tempC).toBe(87);
    expect(tjMaxC).toBe(100);
  });

  it('leaves Tj max null when the distance sensors are absent', () => {
    const noDist = REAL_CPU_SENSORS.filter((s) => !/Distance/.test(s.Text));
    expect(parseLhmCpu(lhmTree(noDist)).tjMaxC).toBeNull();
  });

  it('rejects a nonsensical derived Tj max', () => {
    const silly = [
      { Text: 'CPU Core #1', Value: '40.0 °C' },
      { Text: 'CPU Core #1 Distance to TjMax', Value: '0.5 °C' }, // -> 41, too low
    ];
    expect(parseLhmCpu(lhmTree(silly)).tjMaxC).toBeNull();
  });

  it('does not confuse the identically-named CPU Package POWER sensor', () => {
    // The live payload really does carry two "CPU Package" nodes: one under
    // Temperatures ("87.0 °C") and one under Powers ("26.1 W"). Matching on the
    // name alone would report 26 °C.
    const withPower = [...REAL_CPU_SENSORS, { Text: 'CPU Package', Value: '26.1 W' }];
    expect(parseLhmJson(lhmTree(withPower))).toBe(87);
    // and a payload with ONLY the power sensor yields no temperature at all
    expect(parseLhmJson(lhmTree([{ Text: 'CPU Package', Value: '26.1 W' }]))).toBeNull();
  });

  it('ignores TjMax headroom deltas and aggregates when falling back to cores', () => {
    const noPackage = REAL_CPU_SENSORS.filter((s) => s.Text !== 'CPU Package');
    // hottest genuine core (88), never the 12 °C delta or the derived "Core Max"
    expect(parseLhmJson(lhmTree(noPackage))).toBe(88);
    const onlyDeltas = REAL_CPU_SENSORS.filter((s) => /Distance to TjMax|Average/.test(s.Text));
    expect(parseLhmJson(lhmTree(onlyDeltas))).toBeNull();
  });
});

describe('toGB', () => {
  it('converts bytes to GB with one decimal', () => {
    // the real statfs numbers for C: on this machine
    expect(toGB(4096 * 124699903)).toBe(475.7);
    expect(toGB(4096 * 24908982)).toBe(95);
  });
});
