import { useCallback } from 'react';

/** Marker the desktop main process matches to open this as a pinnable window. */
export const STATS_URL = '?pcstats=1';
const WINDOW_NAME = 'narukami-pcstats';

/**
 * Header chip that opens PC Stats as a REAL window — detached, pinnable
 * (always-on-top) and resizable, so the readout can sit over other apps while
 * you work. The desktop main process intercepts this window.open and sizes the
 * window to whatever display it lands on; in a plain browser it degrades to an
 * ordinary popup of the same page.
 *
 * Reusing the same window name means clicking again focuses the existing window
 * instead of spawning a second one.
 */
export function PcStatsPopup(): JSX.Element {
  const open = useCallback(() => {
    const w = window.open(STATS_URL, WINDOW_NAME);
    w?.focus();
  }, []);

  return (
    <button
      className="pcs-toggle"
      title="PC stats — GPU, temperatures, status (opens a pinnable window)"
      aria-label="PC stats"
      onClick={open}
    >
      PC
    </button>
  );
}
