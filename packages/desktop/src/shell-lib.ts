/**
 * Pure logic lifted out of main.ts so it can be tested.
 *
 * main.ts imports `electron` at module scope, which cannot load outside an Electron runtime — so
 * every decision in the shell (window sizing, drop-target hit testing, preference parsing, the
 * hidden-launch flag) was unreachable from a test, in the largest and least verified file in the
 * repo. Nothing here touches electron, fs or process: each function takes the values the shell
 * already has and returns a result, which is exactly the part worth pinning.
 *
 * Behaviour is preserved verbatim from main.ts — same clamps, same insets, same fallbacks. If a
 * number here changes, the window moves.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShellPrefs {
  /** Close hides to the tray instead of quitting. */
  runInBackground: boolean;
  /** Launch NARUKAMI (hidden) when the user signs in to Windows. */
  startAtLogin: boolean;
}

export const SHELL_PREFS_DEFAULTS: ShellPrefs = { runInBackground: true, startAtLogin: true };

/** Query marker identifying the PC-stats popout window. */
export const STATS_MARK = 'pcstats=1';

export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Size + place the PC Stats window RELATIVE TO THE DISPLAY it will open on, so it works on a 13"
 * laptop and a 4K panel alike: a fraction of the work area, clamped to sane bounds, and never
 * larger than the screen it lands on. Placed in the work area's top-right, inset, so it doesn't
 * cover the main window's header.
 *
 * Takes the work area rather than reading `screen` itself — that is the whole reason it is testable.
 */
export function statsBoundsFor(workArea: Rect): Rect {
  const width = Math.round(clamp(workArea.width * 0.26, 320, 560));
  const height = Math.round(clamp(workArea.height * 0.62, 360, 820));
  // Fit before placing: on a small/scaled display the clamp FLOOR can still exceed the work area.
  const w = Math.min(width, workArea.width - 16);
  const h = Math.min(height, workArea.height - 16);
  return {
    width: w,
    height: h,
    x: Math.round(workArea.x + workArea.width - w - 24),
    y: Math.round(workArea.y + 24),
  };
}

/** Is this the stats popout? Malformed URLs are not — never throw at a window-open decision. */
export function isStatsUrl(url: string): boolean {
  try {
    return new URL(url).search.includes(STATS_MARK);
  } catch {
    return false;
  }
}

/** Inclusive hit test used for terminal drag-and-drop onto the dock. */
export function pointInRect(p: { x: number; y: number }, r: Rect | null): boolean {
  if (!r) return false;
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/**
 * Normalise whatever is on disk into a complete ShellPrefs.
 *
 * Each key falls back INDEPENDENTLY: a file carrying one valid key and one corrupt key keeps the
 * valid one instead of resetting both. A non-boolean is treated as absent — a truthy string like
 * "false" must not silently enable a preference.
 */
export function normalizeShellPrefs(raw: unknown, defaults: ShellPrefs = SHELL_PREFS_DEFAULTS): ShellPrefs {
  const o = (raw ?? {}) as Partial<ShellPrefs>;
  return {
    runInBackground: typeof o.runInBackground === 'boolean' ? o.runInBackground : defaults.runInBackground,
    startAtLogin: typeof o.startAtLogin === 'boolean' ? o.startAtLogin : defaults.startAtLogin,
  };
}

/** Was the app started hidden? The argv half of the check (the login-item half needs electron). */
export function hasHiddenFlag(argv: readonly string[]): boolean {
  return argv.includes('--hidden');
}
