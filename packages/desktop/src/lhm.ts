// LibreHardwareMonitor launcher — the CPU die temperature source.
//
// Windows has no first-party CPU-temperature API: reading the Intel/AMD MSR
// needs a kernel driver, which is why LibreHardwareMonitor's manifest is
// `requireAdministrator`. NARUKAMI runs unelevated, so spawning LHM directly
// would raise a UAC prompt on EVERY launch.
//
// The way out is a Scheduled Task registered once with "run with highest
// privileges" (scripts/setup-lhm.ps1). Task Scheduler bypasses UAC for such a
// task, so `schtasks /run` starts LHM elevated and silently, forever after that
// single consent. If the task was never registered we do nothing at all — the
// PC Stats readout already degrades honestly to "—" with a reason.
//
// The backend reads the sensor over LHM's Remote Web Server on 127.0.0.1:8085
// (services/pcstats.ts `readLhmWeb`); modern LHM ships no WMI provider, so that
// HTTP feed is the only path.
import { execFile } from 'node:child_process';

export const LHM_TASK_NAME = 'NARUKAMI LibreHardwareMonitor';
const LHM_IMAGE = 'LibreHardwareMonitor.exe';

/** Run a command, resolving to null on ANY failure — this is all best-effort. */
function run(file: string, args: string[], timeout = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

/** Is LibreHardwareMonitor already up? Cheap enough to check on every boot. */
export async function isLhmRunning(): Promise<boolean> {
  const out = await run('tasklist.exe', ['/FI', `IMAGENAME eq ${LHM_IMAGE}`, '/NH']);
  return out !== null && out.toLowerCase().includes(LHM_IMAGE.toLowerCase());
}

/** Has the one-time elevated setup been run on this machine? */
export async function lhmTaskRegistered(): Promise<boolean> {
  const out = await run('schtasks.exe', ['/Query', '/TN', LHM_TASK_NAME]);
  return out !== null && out.includes(LHM_TASK_NAME.split(' ')[0]);
}

/**
 * Best-effort: make sure LHM is running so the CPU temperature has a source.
 * Never throws and never blocks startup — a machine without the scheduled task
 * simply keeps reporting the temperature as unavailable.
 *
 * @returns what happened, for the boot log.
 */
export async function ensureLhmRunning(): Promise<
  'already-running' | 'started' | 'no-task' | 'start-failed' | 'not-windows'
> {
  if (process.platform !== 'win32') return 'not-windows';
  if (await isLhmRunning()) return 'already-running';
  if (!(await lhmTaskRegistered())) return 'no-task';
  await run('schtasks.exe', ['/Run', '/TN', LHM_TASK_NAME]);
  // The task starts LHM asynchronously; give it a moment before reporting.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isLhmRunning()) return 'started';
  }
  return 'start-failed';
}
