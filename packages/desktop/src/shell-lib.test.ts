import { describe, expect, it } from 'vitest';
import {
  clamp,
  hasHiddenFlag,
  isStatsUrl,
  normalizeShellPrefs,
  pointInRect,
  statsBoundsFor,
  SHELL_PREFS_DEFAULTS,
} from './shell-lib';

describe('clamp', () => {
  it('passes a value already inside the range through untouched', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it('pins to the bounds outside the range', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
  it('returns lo when the bounds are inverted (lo > hi) — Math.max is outermost, so lo wins', () => {
    // Verified against the implementation rather than assumed: Math.max(10, Math.min(0, 5)) === 10.
    // Documented because inverted bounds are reachable if a work area is ever reported as tiny.
    expect(clamp(5, 10, 0)).toBe(10);
  });
});

describe('statsBoundsFor', () => {
  // The bug class this guards: the clamp FLOOR (320x360) can exceed a small work area, so a naive
  // implementation opens a window larger than the screen it lands on, partly offscreen.
  it('sizes proportionally on a large display and insets from the top-right', () => {
    const b = statsBoundsFor({ x: 0, y: 0, width: 2560, height: 1400 });
    // 26% of 2560 is 666, above the 560 ceiling — so the CEILING is what should apply here.
    expect(b.width).toBe(560);
    expect(b.height).toBe(820);   // 62% of 1400 is 868, likewise capped

    expect(b.x).toBe(2560 - b.width - 24);
    expect(b.y).toBe(24);
  });

  it('never exceeds a SMALL work area even though the clamp floor is bigger', () => {
    const wa = { x: 0, y: 0, width: 300, height: 300 };   // smaller than the 320x360 floor
    const b = statsBoundsFor(wa);
    expect(b.width).toBeLessThanOrEqual(wa.width - 16);
    expect(b.height).toBeLessThanOrEqual(wa.height - 16);
  });

  it('respects a non-zero work-area origin — a second monitor placed left of the primary', () => {
    const b = statsBoundsFor({ x: -1920, y: 0, width: 1920, height: 1080 });
    expect(b.x).toBe(-1920 + 1920 - b.width - 24);
    expect(b.y).toBe(24);
  });

  it('respects a work area inset by a taskbar rather than assuming full screen height', () => {
    const full = statsBoundsFor({ x: 0, y: 0, width: 1920, height: 1080 });
    const taskbar = statsBoundsFor({ x: 0, y: 40, width: 1920, height: 1040 });
    expect(taskbar.y).toBe(64);            // 40 + 24
    expect(taskbar.height).toBeLessThan(full.height);
  });

  it('returns integers — fractional bounds make Electron blur the window', () => {
    const b = statsBoundsFor({ x: 0, y: 0, width: 1337, height: 911 });
    for (const v of [b.x, b.y, b.width, b.height]) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('isStatsUrl', () => {
  it('matches the stats popout marker', () => {
    expect(isStatsUrl('http://127.0.0.1:4000/?pcstats=1')).toBe(true);
    expect(isStatsUrl('http://127.0.0.1:4000/?token=abc&pcstats=1')).toBe(true);
  });
  it('does not match the main window', () => {
    expect(isStatsUrl('http://127.0.0.1:4000/')).toBe(false);
    expect(isStatsUrl('http://127.0.0.1:4000/?other=1')).toBe(false);
  });
  it('is false — never throws — on a malformed URL, since it gates a window-open decision', () => {
    expect(isStatsUrl('not a url')).toBe(false);
    expect(isStatsUrl('')).toBe(false);
  });
});

describe('pointInRect', () => {
  const r = { x: 10, y: 20, width: 100, height: 50 };
  it('accepts a point inside', () => expect(pointInRect({ x: 50, y: 40 }, r)).toBe(true));
  it('accepts the edges — the dock hit test is inclusive', () => {
    expect(pointInRect({ x: 10, y: 20 }, r)).toBe(true);
    expect(pointInRect({ x: 110, y: 70 }, r)).toBe(true);
  });
  it('rejects a point just outside', () => {
    expect(pointInRect({ x: 9, y: 40 }, r)).toBe(false);
    expect(pointInRect({ x: 111, y: 40 }, r)).toBe(false);
    expect(pointInRect({ x: 50, y: 71 }, r)).toBe(false);
  });
  it('rejects everything when there is no dock', () => {
    expect(pointInRect({ x: 50, y: 40 }, null)).toBe(false);
  });
});

describe('normalizeShellPrefs', () => {
  it('returns the defaults for a missing or empty file', () => {
    expect(normalizeShellPrefs(undefined)).toEqual(SHELL_PREFS_DEFAULTS);
    expect(normalizeShellPrefs({})).toEqual(SHELL_PREFS_DEFAULTS);
  });
  it('keeps explicit false — the whole point of the pref is turning it off', () => {
    expect(normalizeShellPrefs({ runInBackground: false, startAtLogin: false }))
      .toEqual({ runInBackground: false, startAtLogin: false });
  });
  it('falls back PER KEY, so one corrupt value does not reset the other', () => {
    expect(normalizeShellPrefs({ runInBackground: false, startAtLogin: 'yes' }))
      .toEqual({ runInBackground: false, startAtLogin: true });
  });
  it('treats a truthy non-boolean as absent — "false" must not enable a preference', () => {
    expect(normalizeShellPrefs({ runInBackground: 'false' }).runInBackground).toBe(true);
    expect(normalizeShellPrefs({ runInBackground: 0 }).runInBackground).toBe(true);
  });
  it('survives junk types instead of throwing during startup', () => {
    expect(normalizeShellPrefs(null)).toEqual(SHELL_PREFS_DEFAULTS);
    expect(normalizeShellPrefs('nonsense' as unknown)).toEqual(SHELL_PREFS_DEFAULTS);
  });
});

describe('hasHiddenFlag', () => {
  it('detects the start-at-login flag the Run entry passes', () => {
    expect(hasHiddenFlag(['C:/app/NARUKAMI.exe', '--hidden'])).toBe(true);
  });
  it('is false for a normal launch', () => {
    expect(hasHiddenFlag(['C:/app/NARUKAMI.exe'])).toBe(false);
  });
  it('does not match a substring — "--hidden-thing" is a different flag', () => {
    expect(hasHiddenFlag(['app', '--hidden-thing'])).toBe(false);
  });
});
