import { useEffect, useRef } from 'react';
import { subscribeActivity } from '../lib/activityBus';
import { addPulse, decayLevel } from '../lib/waveModel';

interface Props {
  // Sustained floor: true while any run is actively producing output. Keeps the
  // wave alive during a streaming process even between individual output chunks;
  // when false and no pulses arrive, the wave decays to a near-flat idle line.
  active: boolean;
  height?: number;
}

// Layered sine waves — different frequency, phase offset, colour token, alpha.
const LAYERS = [
  { f: 1.4, p: 0.0, a: 1.0, w: 1.7, c: '--accent' },
  { f: 2.3, p: 1.7, a: 0.55, w: 1.3, c: '--accent-2' },
  { f: 3.7, p: 3.1, a: 0.3, w: 1.0, c: '--accent-2' },
] as const;

/**
 * A live oscilloscope-style wave in the header. It rides the global activity bus
 * (pulsed by every terminal's output stream), so it moves whenever a process is
 * doing something anywhere on the project and calms to a flat line when idle.
 */
export function ActivityWave({ active, height = 26 }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const kickRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let level = 0; // decaying spike level (0..1)
    let phase = 0;
    let raf = 0;
    let running = false;
    let idleFrames = 0;
    let w = 1, h = 1, tick = 0;
    let c1 = '#ff2d3c';
    const colors: Record<string, string> = {};

    const readColors = () => {
      const cs = getComputedStyle(canvas);
      for (const L of LAYERS) colors[L.c] = cs.getPropertyValue(L.c).trim() || colors[L.c] || c1;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, Math.round(r.width));
      h = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      const floor = activeRef.current ? 0.34 : 0;
      const lvl = Math.max(level, floor);
      const mid = h / 2;
      const maxAmp = mid - 1.5;
      const amp = maxAmp * (0.1 + lvl * 0.9);
      ctx.clearRect(0, 0, w, h);
      for (const L of LAYERS) {
        ctx.beginPath();
        ctx.globalAlpha = L.a * (0.35 + lvl * 0.65);
        ctx.strokeStyle = colors[L.c] || c1;
        ctx.lineWidth = L.w;
        for (let x = 0; x <= w; x += 2) {
          const k = (x / w) * Math.PI * 2 * L.f + phase * (1 + L.f * 0.15) + L.p;
          const edge = Math.sin((x / w) * Math.PI); // taper to 0 at both ends
          const y = mid + Math.sin(k) * amp * L.a * edge;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const loop = () => {
      const floor = activeRef.current ? 0.34 : 0;
      level = decayLevel(level, floor);
      const lvl = Math.max(level, floor);
      phase += 0.03 + lvl * 0.16;
      if (++tick % 24 === 0) readColors();
      draw();
      // Stop the rAF once truly idle to spare CPU; a pulse or active=true resumes.
      if (lvl < 0.02) {
        if (++idleFrames > 120) {
          running = false;
          return;
        }
      } else {
        idleFrames = 0;
      }
      raf = requestAnimationFrame(loop);
    };

    const kick = () => {
      if (reduce) {
        draw();
        return;
      }
      idleFrames = 0;
      if (!running) {
        running = true;
        raf = requestAnimationFrame(loop);
      }
    };
    kickRef.current = kick;

    readColors();
    resize();
    const ro = new ResizeObserver(() => {
      resize();
      if (reduce) draw();
    });
    ro.observe(canvas);

    const unsub = subscribeActivity((bytes) => {
      level = addPulse(level, bytes);
      kick();
    });

    if (reduce) draw();
    else kick();

    return () => {
      cancelAnimationFrame(raf);
      unsub();
      ro.disconnect();
      kickRef.current = () => {};
    };
  }, []);

  // If a process goes active while the loop is parked, wake it back up.
  useEffect(() => {
    if (active) kickRef.current();
  }, [active]);

  return <canvas ref={canvasRef} className="activity-wave" style={{ height }} aria-hidden="true" />;
}
