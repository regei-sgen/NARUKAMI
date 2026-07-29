import { desktop } from './desktop';

/**
 * One shared "is this window actually visible?" signal for poll loops and
 * cosmetic animation.
 *
 * In the desktop shell the Page Visibility API is USELESS: the shell sets
 * backgroundThrottling:false (live terminals must keep streaming), which pins
 * document.visibilityState to 'visible' even when the window is minimized. The
 * Electron main process therefore forwards real minimize/restore events over
 * IPC (desktop().onVisibility). In a plain browser tab we fall back to the
 * standard visibilitychange event.
 *
 * Consumers: poll loops skip their tick while hidden (and refresh immediately
 * on becoming visible via onWindowVisibility); a `win-hidden` class on <html>
 * lets CSS pause the infinite pulse animations that would otherwise composite
 * every frame for a window nobody can see. WebSocket streaming and terminal
 * buffers are deliberately NOT gated — only cosmetic/poll work pauses.
 */

let hidden = false;
const subs = new Set<(hidden: boolean) => void>();

function set(next: boolean): void {
  if (next === hidden) return;
  hidden = next;
  document.documentElement.classList.toggle('win-hidden', next);
  for (const cb of subs) cb(next);
}

const bridge = desktop();
if (bridge?.onVisibility) {
  bridge.onVisibility(set);
} else {
  document.addEventListener('visibilitychange', () => set(document.hidden));
}

/** True while the window is minimized/hidden — poll ticks should no-op. */
export function windowHidden(): boolean {
  return hidden;
}

/**
 * Subscribe to visibility flips. Returns an unsubscribe. Typical poll usage:
 * skip the tick when windowHidden(), and on `hidden === false` run one
 * immediate refresh so the view catches up without waiting for the next tick.
 */
export function onWindowVisibility(cb: (hidden: boolean) => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}
