import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

// The lock lives next to the token file, so point that at a throwaway temp dir
// BEFORE any import (config.ts reads RUNNER_TOKEN_FILE at load time) — and stop
// index.ts's CLI auto-start, since this suite imports it for the boot wiring.
const { lockHome } = vi.hoisted(() => {
  const tmp = process.env.TEMP ?? process.env.TMPDIR ?? '.';
  const home = `${tmp}/narukami-lock-test-${process.pid}-${Date.now()}`;
  process.env.RUNNER_TOKEN_FILE = `${home}/.runner-token`;
  process.env.NARUKAMI_EMBEDDED = '1';
  return { lockHome: home };
});

import { anotherInstanceRunning, claimInstanceLock, releaseInstanceLock } from './instanceLock';
import { reconcileOnBoot } from '../index';

const LOCK_DIR = path.join(lockHome, '.narukami-locks');
const LEGACY_LOCK = path.join(lockHome, '.narukami.lock');

/** Everything currently recorded as an instance, in EITHER on-disk layout. */
function recordedOnDisk(): string[] {
  const out: string[] = [];
  try {
    out.push(...fs.readdirSync(LOCK_DIR));
  } catch {
    /* no lock dir */
  }
  try {
    out.push(fs.readFileSync(LEGACY_LOCK, 'utf8').trim());
  } catch {
    /* no legacy lock */
  }
  return out;
}

/** Record `pid` the way a pre-lock-dir instance did: one shared pid file. */
function seedLegacyLock(pid: number): void {
  fs.writeFileSync(LEGACY_LOCK, String(pid), 'utf8');
}

/** Record `pid` the way a current instance does: its own file in the lock dir. */
function seedLockEntry(pid: number | string): void {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCK_DIR, String(pid)), String(Date.now()), 'utf8');
}

const children: ChildProcess[] = [];

/** A real, live process to stand in for another instance. Killed in afterAll. */
function spawnSleeper(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
  });
  children.push(child);
  return child.pid as number;
}

/** A pid that is definitely NOT alive: spawn a process and wait for it to exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return pid;
}

beforeAll(() => {
  fs.mkdirSync(lockHome, { recursive: true });
});

beforeEach(() => {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  fs.rmSync(LEGACY_LOCK, { force: true });
});

afterAll(() => {
  for (const c of children) c.kill();
  fs.rmSync(lockHome, { recursive: true, force: true });
});

describe('anotherInstanceRunning', () => {
  it('is false with no lock at all', () => {
    expect(anotherInstanceRunning()).toBe(false);
  });

  it('is false for our OWN pid — we are not "another" instance', () => {
    seedLockEntry(process.pid);
    expect(anotherInstanceRunning()).toBe(false);
  });

  it('is false for a dead pid', async () => {
    seedLockEntry(await deadPid());
    expect(anotherInstanceRunning()).toBe(false);
  });

  it('is true for a live peer', () => {
    seedLockEntry(spawnSleeper());
    expect(anotherInstanceRunning()).toBe(true);
  });

  it('is false for garbage entries', () => {
    seedLockEntry('not-a-pid');
    seedLockEntry(-1);
    seedLockEntry(0);
    expect(anotherInstanceRunning()).toBe(false);
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    fs.writeFileSync(LEGACY_LOCK, 'nonsense\n', 'utf8');
    expect(anotherInstanceRunning()).toBe(false);
  });

  it('still sees a live peer that only wrote the legacy single-pid lock', () => {
    // Mixed versions on one database: missing a live peer is the dangerous
    // direction (we would reconcile its live runs to 'exited'), so keep reading
    // the old layout. A stale legacy file only costs us a skipped reconcile.
    seedLegacyLock(spawnSleeper());
    expect(anotherInstanceRunning()).toBe(true);
  });
});

// ── item 21 ─────────────────────────────────────────────────────────────────
describe('every instance records itself (item 21)', () => {
  it('claims the lock on boot EVEN WHEN a peer already holds it', async () => {
    // The claim used to sit inside the `else` of the peer check, so instance #2
    // never recorded its presence at all. Instance #1 then deleted the only lock
    // on exit and a third boot reconciled #2's genuinely-live runs to 'exited'.
    seedLegacyLock(spawnSleeper());
    expect(anotherInstanceRunning()).toBe(true); // …so this boot skips reconcile

    await reconcileOnBoot();

    expect(recordedOnDisk()).toContain(String(process.pid));
  });

  it('a departing instance releases only its OWN entry', () => {
    // One shared pid file meant the first instance's exit handler removed the
    // protection a SURVIVING instance was relying on.
    const survivor = spawnSleeper();
    seedLockEntry(survivor);
    claimInstanceLock();
    expect(recordedOnDisk()).toEqual(
      expect.arrayContaining([String(survivor), String(process.pid)]),
    );

    releaseInstanceLock(); // what our own process-exit handler does

    expect(recordedOnDisk()).not.toContain(String(process.pid));
    expect(recordedOnDisk()).toContain(String(survivor));
    expect(anotherInstanceRunning()).toBe(true);
  });

  it('sweeps entries left by instances that died without releasing', async () => {
    const crashed = await deadPid();
    seedLockEntry(crashed);
    claimInstanceLock();
    expect(recordedOnDisk()).not.toContain(String(crashed));
    releaseInstanceLock();
  });
});
