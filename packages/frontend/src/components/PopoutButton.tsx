import { type PointerEvent as ReactPointerEvent, useRef } from 'react';

// Small ⤢ button that pops a piece out into its own window. A plain click fires
// `onActivate()`; a press-and-drag past a threshold fires `onActivate(pos)` with
// the cursor in *screen* coordinates (so the shell can spawn the window under the
// pointer) and swallows the trailing click. Mirrors the Browser view's whole-view
// tear-off gesture, per viewport.
export function PopoutButton({
  title,
  onActivate,
}: {
  title: string;
  onActivate: (pos?: { x: number; y: number }) => void;
}) {
  const dragged = useRef(false);

  const begin = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    dragged.current = false;
    const onMove = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 8) {
        dragged.current = true;
        document.body.classList.add('tab-tearing');
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('tab-tearing');
      if (dragged.current) onActivate({ x: ev.screenX, y: ev.screenY });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <button
      type="button"
      className="bv-vp-popout"
      title={title}
      aria-label={title}
      onPointerDown={begin}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return; // tail of a drag — already popped out
        }
        onActivate();
      }}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          d="M2.5 6V3.5A1 1 0 0 1 3.5 2.5H6M10 2.5H12.5A1 1 0 0 1 13.5 3.5V6M13.5 10V12.5A1 1 0 0 1 12.5 13.5H10M6 13.5H3.5A1 1 0 0 1 2.5 12.5V10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
