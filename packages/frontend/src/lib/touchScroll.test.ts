import { describe, it, expect, beforeEach } from 'vitest';
import { attachTouchWheelBridge } from './touchScroll';

// jsdom has no TouchEvent constructor — build a plain event carrying the
// `touches` shape the bridge reads. cancelable so preventDefault registers.
function touchEvent(type: string, clientY: number, clientX = 50): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', {
    value: [{ clientX, clientY }],
  });
  return e;
}

describe('attachTouchWheelBridge', () => {
  let container: HTMLDivElement;
  let inner: HTMLDivElement;
  let wheels: WheelEvent[];

  beforeEach(() => {
    container = document.createElement('div');
    inner = document.createElement('div'); // stands in for xterm's screen element
    container.appendChild(inner);
    document.body.appendChild(container);
    wheels = [];
    container.addEventListener('wheel', (e) => wheels.push(e as WheelEvent));
  });

  it('converts an upward finger drag into a positive-deltaY wheel on the touched element', () => {
    attachTouchWheelBridge(container);
    inner.dispatchEvent(touchEvent('touchstart', 300));
    const move = touchEvent('touchmove', 260);
    inner.dispatchEvent(move);
    expect(wheels).toHaveLength(1);
    expect(wheels[0].deltaY).toBe(40); // finger up = scroll down
    expect(wheels[0].deltaMode).toBe(WheelEvent.DOM_DELTA_PIXEL);
    // The pan is consumed so the page doesn't rubber-band under the terminal.
    expect(move.defaultPrevented).toBe(true);
  });

  it('tracks the finger across moves (deltas are per-move, not from touchstart)', () => {
    attachTouchWheelBridge(container);
    inner.dispatchEvent(touchEvent('touchstart', 300));
    inner.dispatchEvent(touchEvent('touchmove', 280));
    inner.dispatchEvent(touchEvent('touchmove', 250));
    expect(wheels.map((w) => w.deltaY)).toEqual([20, 30]);
  });

  it('stands down when xterm already consumed the touchmove (its viewport touch-scroll)', () => {
    attachTouchWheelBridge(container);
    inner.dispatchEvent(touchEvent('touchstart', 300));
    const move = touchEvent('touchmove', 260);
    move.preventDefault(); // what xterm's own handler does when it scrolls
    inner.dispatchEvent(move);
    expect(wheels).toHaveLength(0);
    // ...but keeps tracking, so the NEXT unconsumed move uses the right origin.
    inner.dispatchEvent(touchEvent('touchmove', 250));
    expect(wheels.map((w) => w.deltaY)).toEqual([10]);
  });

  it('ignores moves without a preceding touchstart and after touchend', () => {
    attachTouchWheelBridge(container);
    inner.dispatchEvent(touchEvent('touchmove', 260));
    expect(wheels).toHaveLength(0);
    inner.dispatchEvent(touchEvent('touchstart', 300));
    inner.dispatchEvent(new Event('touchend', { bubbles: true }));
    inner.dispatchEvent(touchEvent('touchmove', 260));
    expect(wheels).toHaveLength(0);
  });

  it('detaches cleanly', () => {
    const detach = attachTouchWheelBridge(container);
    detach();
    inner.dispatchEvent(touchEvent('touchstart', 300));
    inner.dispatchEvent(touchEvent('touchmove', 260));
    expect(wheels).toHaveLength(0);
  });
});
