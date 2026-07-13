import { useEffect } from 'react';
import { onWindowVisibility, windowHidden } from './visibility';

/**
 * Run `fn` immediately and then every `ms` — but skip ticks while the window
 * is hidden/minimized, and fire one immediate catch-up refresh when it becomes
 * visible again. This is the standard shape for all dashboard/status pollers:
 * their data is server-side (nothing is lost while paused), so polling a view
 * nobody can see is pure waste — some of these ticks spawn git or node child
 * processes backend-side.
 *
 * `fn` must be referentially stable (useCallback) or the interval re-arms
 * every render.
 */
export function usePollWhileVisible(fn: () => void, ms: number): void {
  useEffect(() => {
    fn();
    const id = setInterval(() => {
      if (!windowHidden()) fn();
    }, ms);
    const off = onWindowVisibility((hidden) => {
      if (!hidden) fn();
    });
    return () => {
      clearInterval(id);
      off();
    };
  }, [fn, ms]);
}
