import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// lhm.ts shells out to tasklist/schtasks, so the child_process boundary is mocked. Mocking is the
// point here rather than a shortcut: the real commands answer differently on every machine (and not
// at all off Windows), and what needs pinning is this module's DECISION LOGIC — which strings it
// treats as "running", and that it never throws into Electron's boot path.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

// Helper: make the next execFile call behave like a command that succeeded / failed.
const succeedsWith = (stdout: string) => {
  execFileMock.mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
    cb(null, stdout);
  });
};
const fails = () => {
  execFileMock.mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
    cb(new Error('ENOENT'), '');
  });
};

let lhm: typeof import('./lhm');
beforeEach(async () => {
  execFileMock.mockReset();
  vi.resetModules();
  lhm = await import('./lhm');
});
afterEach(() => vi.restoreAllMocks());

describe('isLhmRunning', () => {
  it('is true when tasklist lists the image', async () => {
    succeedsWith('LibreHardwareMonitor.exe          1234 Console   1    52,000 K');
    await expect(lhm.isLhmRunning()).resolves.toBe(true);
  });

  it('matches case-insensitively — tasklist casing is not guaranteed', async () => {
    succeedsWith('librehardwaremonitor.EXE          1234 Console');
    await expect(lhm.isLhmRunning()).resolves.toBe(true);
  });

  it('is false for tasklist\'s "no tasks" reply rather than treating any output as a hit', async () => {
    succeedsWith('INFO: No tasks are running which match the specified criteria.');
    await expect(lhm.isLhmRunning()).resolves.toBe(false);
  });

  it('is false — never throws — when the command itself fails', async () => {
    fails();
    await expect(lhm.isLhmRunning()).resolves.toBe(false);
  });
});

describe('lhmTaskRegistered', () => {
  it('is true when schtasks echoes the task name back', async () => {
    succeedsWith(`Folder: \\\nTaskName    Next Run Time    Status\n${'NARUKAMI'} LibreHardwareMonitor   N/A   Ready`);
    await expect(lhm.lhmTaskRegistered()).resolves.toBe(true);
  });

  it('is false when the task is absent (schtasks exits non-zero)', async () => {
    fails();
    await expect(lhm.lhmTaskRegistered()).resolves.toBe(false);
  });
});

describe('ensureLhmRunning', () => {
  it('short-circuits when LHM is already up and does not touch schtasks', async () => {
    succeedsWith('LibreHardwareMonitor.exe   1234 Console');
    const res = await lhm.ensureLhmRunning();
    expect(String(JSON.stringify(res))).toMatch(/already|running/i);
    expect(execFileMock).toHaveBeenCalledTimes(1); // no schtasks probe, no start attempt
  });

  it('reports a reason instead of throwing when nothing is available', async () => {
    fails();  // isLhmRunning
    fails();  // lhmTaskRegistered
    fails();  // any start attempt
    const res = await lhm.ensureLhmRunning();
    expect(res).toBeTruthy();
    // The contract that matters for boot: it resolves, it never rejects.
  });
});

describe('module contract', () => {
  it('exports a stable task name — the elevated setup script and the app must agree on it', () => {
    expect(lhm.LHM_TASK_NAME).toBe('NARUKAMI LibreHardwareMonitor');
  });
});
