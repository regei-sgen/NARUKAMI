/**
 * Bridges touch panning to xterm's wheel pipeline so a phone can scroll the
 * shared session. xterm 5.x ignores touch whenever the running app enables
 * mouse tracking (Claude Code does — see the ?1000/?1002/?1006 cleanup in
 * MobileTerminal's exit handler), and alt-screen apps only receive scroll via
 * wheel events, which phones never emit. Converting the finger's vertical
 * delta into synthetic WheelEvents routes every case through xterm's own
 * wheel logic: scrollback scrolling, arrow-key fallback in the alt screen,
 * and SGR wheel reports to mouse-tracking apps.
 *
 * xterm's built-in viewport touch-scroll (active when mouse tracking is OFF)
 * cancels the touchmove it consumes, so `defaultPrevented` tells us to stand
 * down and avoid double-scrolling.
 */
export function attachTouchWheelBridge(container: HTMLElement): () => void {
  let lastY: number | null = null;

  const onTouchStart = (e: TouchEvent): void => {
    lastY = e.touches.length === 1 ? e.touches[0].clientY : null;
  };

  const onTouchMove = (e: TouchEvent): void => {
    if (lastY == null || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dy = lastY - t.clientY;
    lastY = t.clientY;
    if (e.defaultPrevented || dy === 0) return;
    e.preventDefault(); // we own this pan — stop the page from rubber-banding
    e.target?.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: t.clientX,
        clientY: t.clientY,
        deltaY: dy,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      }),
    );
  };

  const onTouchEnd = (): void => {
    lastY = null;
  };

  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: false });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });
  return () => {
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchmove', onTouchMove);
    container.removeEventListener('touchend', onTouchEnd);
    container.removeEventListener('touchcancel', onTouchEnd);
  };
}
