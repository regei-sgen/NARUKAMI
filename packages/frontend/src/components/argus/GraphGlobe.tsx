import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { onWindowVisibility, windowHidden } from '../../lib/visibility';

/**
 * GraphGlobe — a dependency-free, interactive 3D graph renderer. Nodes settle onto
 * a spherical shell via a light force sim; the globe drags to rotate and scrolls to
 * zoom. It is deliberately generic (colors/labels/highlights/clicks are all props)
 * so both the Argus memory graph and the project Code Map share one engine.
 */

export interface GlobeNode {
  id: string;
  label: string;
  kind: string;
}
export interface GlobeEdge {
  source: string;
  target: string;
  kind?: string;
  fuzzy?: boolean;
}

interface P3 {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface GraphGlobeProps<T extends GlobeNode = GlobeNode> {
  nodes: T[];
  edges: GlobeEdge[];
  height?: number;
  /** Fill color for a node. */
  colorOf: (n: T) => string;
  /** Base radius for a node (screen px at zoom 1, before perspective). */
  radiusOf?: (n: T) => number;
  /** Base opacity for a node (e.g. ghosts dimmer). */
  alphaOf?: (n: T) => number;
  /** Node ids that should glow AND pulse (e.g. the selected project, ongoing edits). */
  highlightIds?: Set<string>;
  /** Node ids that glow steadily (no pulse) — a lower tier than highlightIds. */
  steadyIds?: Set<string>;
  /**
   * When false, active (highlighted) nodes are shown at full opacity with no glow
   * halo/ring — the distinction comes purely from inactive nodes being dimmed.
   * Ongoing (highlightIds) nodes still pulse, via their opacity. Default true.
   */
  haloGlow?: boolean;
  /** Click a node (drag is suppressed so a rotate isn't a click). */
  onNodeClick?: (n: T) => void;
  /** Tooltip body for the hovered node. */
  renderTooltip?: (n: T) => ReactNode;
  /** Show a label for this node even when not hovered/highlighted. */
  alwaysLabel?: (n: T) => boolean;
}

const REPULSION = 1700;
const SPRING = 0.055;
const SPRING_REST = 30;
const DAMPING = 0.8;

export function GraphGlobe<T extends GlobeNode = GlobeNode>({
  nodes,
  edges,
  height = 540,
  colorOf,
  radiusOf,
  alphaOf,
  highlightIds,
  steadyIds,
  haloGlow,
  onNodeClick,
  renderTooltip,
  alwaysLabel,
}: GraphGlobeProps<T>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<Map<string, P3>>(new Map());
  const alphaRef = useRef(1);
  const rotRef = useRef({ yaw: 0.5, pitch: -0.28 });
  const zoomRef = useRef(1);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const hoverRef = useRef<T | null>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const runningRef = useRef(false); // is the rAF loop currently scheduled?
  const wakeRef = useRef<(() => void) | null>(null); // restart the loop from outside the effect
  const [tip, setTip] = useState<{ x: number; y: number; node: T } | null>(null);
  const tipRef = useRef<{ x: number; y: number; node: T } | null>(null);
  tipRef.current = tip;

  // Keep the render callbacks fresh without re-running the animation effect.
  const cbRef = useRef({ colorOf, radiusOf, alphaOf, highlightIds, steadyIds, haloGlow, alwaysLabel });
  cbRef.current = { colorOf, radiusOf, alphaOf, highlightIds, steadyIds, haloGlow, alwaysLabel };

  // Stable content signature: the sim reheats only when the node/edge SET changes,
  // not on prop identity churn (so the settled globe stays put).
  const graphSig = useMemo(
    () => `${nodes.map((n) => n.id).join('|')}#${edges.length}`,
    [nodes, edges],
  );

  useEffect(() => {
    alphaRef.current = 1;
  }, [graphSig]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let W = wrap.clientWidth || 800;
    const H = height;
    let R = Math.min(W, H) * 0.34;
    const sizeCanvas = () => {
      W = wrap.clientWidth || 800;
      R = Math.min(W, H) * 0.34;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    sizeCanvas();
    const onResize = () => {
      sizeCanvas();
      wakeRef.current?.(); // repaint at the new size even if the loop was parked
    };
    window.addEventListener('resize', onResize);

    const pos = posRef.current;
    const seen = new Set(nodes.map((n) => n.id));
    for (const id of [...pos.keys()]) if (!seen.has(id)) pos.delete(id);
    const N = Math.max(1, nodes.length);
    nodes.forEach((n, i) => {
      if (pos.has(n.id)) return;
      const phi = Math.acos(1 - (2 * (i + 0.5)) / N);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      pos.set(n.id, {
        x: R * Math.sin(phi) * Math.cos(theta),
        y: R * Math.cos(phi),
        z: R * Math.sin(phi) * Math.sin(theta),
        vx: 0,
        vy: 0,
        vz: 0,
      });
    });

    const radius = (n: T) => cbRef.current.radiusOf?.(n) ?? 5;

    let raf = 0;
    let tick = 0;
    let glowTimer: ReturnType<typeof setTimeout> | null = null;
    const step = () => {
      tick += 1;
      const alpha = alphaRef.current;

      if (alpha > 0.02) {
        for (let a = 0; a < nodes.length; a += 1) {
          const pa = pos.get(nodes[a].id)!;
          for (let b = a + 1; b < nodes.length; b += 1) {
            const pb = pos.get(nodes[b].id)!;
            let dx = pa.x - pb.x;
            let dy = pa.y - pb.y;
            let dz = pa.z - pb.z;
            let d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < 1) {
              dx = (a - b) * 0.5 + 0.1;
              dy = 0.1;
              dz = 0.1;
              d2 = dx * dx + dy * dy + dz * dz;
            }
            const d = Math.sqrt(d2);
            const f = (REPULSION * alpha) / d2;
            pa.vx += (dx / d) * f;
            pa.vy += (dy / d) * f;
            pa.vz += (dz / d) * f;
            pb.vx -= (dx / d) * f;
            pb.vy -= (dy / d) * f;
            pb.vz -= (dz / d) * f;
          }
        }
        for (const e of edges) {
          const ps = pos.get(e.source);
          const pt = pos.get(e.target);
          if (!ps || !pt) continue;
          const dx = pt.x - ps.x;
          const dy = pt.y - ps.y;
          const dz = pt.z - ps.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
          const f = ((d - SPRING_REST) / d) * SPRING * alpha;
          ps.vx += dx * f;
          ps.vy += dy * f;
          ps.vz += dz * f;
          pt.vx -= dx * f;
          pt.vy -= dy * f;
          pt.vz -= dz * f;
        }
        for (const n of nodes) {
          const p = pos.get(n.id)!;
          p.vx *= DAMPING;
          p.vy *= DAMPING;
          p.vz *= DAMPING;
          p.x += p.vx;
          p.y += p.vy;
          p.z += p.vz;
          const d = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) || 0.01;
          const k = R / d;
          p.x *= k;
          p.y *= k;
          p.z *= k;
        }
        alphaRef.current = alpha * 0.985;
      }

      const { yaw, pitch } = rotRef.current;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const CAM = R * 3.4;
      const zoom = zoomRef.current;
      const proj = (p: P3) => {
        const x1 = p.x * cy + p.z * sy;
        const z1 = -p.x * sy + p.z * cy;
        const y2 = p.y * cp - z1 * sp;
        const z2 = p.y * sp + z1 * cp;
        const persp = (CAM / (CAM - z2)) * zoom;
        return { sx: W / 2 + x1 * persp, sy: H / 2 - y2 * persp, depth: z2, persp };
      };

      const scr = new Map<string, { sx: number; sy: number; depth: number; persp: number }>();
      for (const n of nodes) scr.set(n.id, proj(pos.get(n.id)!));

      let hover: T | null = null;
      const m = mouseRef.current;
      if (m && !draggingRef.current) {
        let bestDepth = -Infinity;
        for (const n of nodes) {
          const s = scr.get(n.id)!;
          const rr = Math.max(2, radius(n) * s.persp) + 5;
          const dx = s.sx - m.x;
          const dy = s.sy - m.y;
          if (dx * dx + dy * dy <= rr * rr && s.depth > bestDepth) {
            bestDepth = s.depth;
            hover = n;
          }
        }
      }
      hoverRef.current = hover;

      ctx.clearRect(0, 0, W, H);
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, R * zoom, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,45,60,0.10)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const highlight = cbRef.current.highlightIds;
      const steady = cbRef.current.steadyIds;
      const isGlow = (id: string) => !!(highlight?.has(id) || steady?.has(id));
      const edgesByDepth = edges
        .map((e) => {
          const a = scr.get(e.source);
          const b = scr.get(e.target);
          return a && b ? { e, a, b, depth: (a.depth + b.depth) / 2 } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((p, q) => p.depth - q.depth);
      for (const { e, a, b, depth } of edgesByDepth) {
        const front = (depth + R) / (2 * R);
        const live = isGlow(e.source) && isGlow(e.target);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        if (e.fuzzy) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = `rgba(255,176,32,${(0.12 + 0.3 * front).toFixed(3)})`;
        } else {
          ctx.setLineDash([]);
          const base = live ? [255, 45, 60] : [120, 128, 150];
          ctx.strokeStyle = `rgba(${base[0]},${base[1]},${base[2]},${((live ? 0.28 : 0.1) + 0.32 * front).toFixed(3)})`;
        }
        ctx.lineWidth = live ? 1.4 : 1;
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const hasGlow = (!!highlight && highlight.size > 0) || (!!steady && steady.size > 0);
      const halo = cbRef.current.haloGlow !== false;
      const pulse = 0.5 + 0.5 * Math.sin(tick * 0.09);
      const order = [...nodes].sort((p, q) => scr.get(p.id)!.depth - scr.get(q.id)!.depth);
      for (const n of order) {
        const s = scr.get(n.id)!;
        const front = (s.depth + R) / (2 * R);
        // pulseGlow (in highlightIds) breathes; steadyGlow (in steadyIds only) is
        // a calm, brighter tier — "changed but idle".
        const pulseGlow = !!highlight && highlight.has(n.id);
        const steadyGlow = !pulseGlow && !!steady && steady.has(n.id);
        const glow = pulseGlow || steadyGlow;
        const gp = pulseGlow ? pulse : 0.85; // halo intensity
        const r = Math.max(1.6, radius(n) * s.persp * (glow && halo ? 1.28 : 1));
        const color = cbRef.current.colorOf(n);
        // In no-halo mode a steady changed node reads as a plain full-opacity dot;
        // an ongoing node keeps a pulsing halo (drawn below). The contrast for the
        // steady tier is carried entirely by the dimmed inactives.
        const drawHalo = pulseGlow || (glow && halo);
        let alphaN = (0.4 + 0.6 * front) * (cbRef.current.alphaOf?.(n) ?? 1);
        if (hasGlow && !glow) alphaN *= 0.4;
        if (glow && !halo) alphaN = 1;

        if (drawHalo) {
          ctx.globalAlpha = (0.22 + 0.38 * gp) * front;
          ctx.beginPath();
          ctx.arc(s.sx, s.sy, r + 5 + (pulseGlow ? 3 * pulse : 2), 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.shadowColor = color;
          ctx.shadowBlur = pulseGlow ? 14 : 10;
        }

        ctx.globalAlpha = alphaN;
        ctx.beginPath();
        ctx.arc(s.sx, s.sy, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.shadowBlur = 0;

        if (glow && halo) {
          ctx.globalAlpha = 0.7 + 0.3 * gp;
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = '#e8ebf2';
          ctx.stroke();
        }
        if (hover === n) {
          ctx.globalAlpha = 1;
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        const wantLabel = hover === n || glow || cbRef.current.alwaysLabel?.(n);
        if (wantLabel && front > 0.35) {
          ctx.globalAlpha = Math.min(1, 0.55 + 0.45 * front);
          ctx.fillStyle = 'rgba(232,235,242,0.9)';
          ctx.font = '10px ui-monospace, monospace';
          ctx.fillText(n.label.slice(0, 26), s.sx + r + 3, s.sy + 3);
          ctx.globalAlpha = 1;
        }
      }

      if (m && hover) setTip({ x: m.x, y: m.y, node: hover });
      else if (tipRef.current) setTip(null);

      // Idle-stop (same pattern as GraphFlat): full rate only while the layout
      // is settling or the user is interacting. A settled globe whose only
      // motion is the pulsing highlight halo throttles to ~12fps (the slow
      // sine reads identically); a fully static globe parks the loop at ~0 CPU
      // until wake() reschedules it. Without this the per-frame projection +
      // edge sort + full repaint ran at display refresh forever — including
      // while the window was minimized (backgroundThrottling:false).
      const interacting = alphaRef.current > 0.02 || !!mouseRef.current || draggingRef.current;
      const glowOnly = !interacting && !!highlight && highlight.size > 0;
      if (windowHidden()) runningRef.current = false; // park; visibility effect wakes us
      else if (interacting) raf = requestAnimationFrame(step);
      else if (glowOnly)
        glowTimer = setTimeout(() => {
          glowTimer = null;
          raf = requestAnimationFrame(step);
        }, 80);
      else runningRef.current = false;
    };
    const wake = () => {
      // A glow-throttled loop is "running" but its next frame is ~80ms out —
      // interaction needs the frame NOW, so cancel the timer and go direct.
      if (glowTimer) {
        clearTimeout(glowTimer);
        glowTimer = null;
        raf = requestAnimationFrame(step);
        return;
      }
      if (runningRef.current) return;
      runningRef.current = true;
      raf = requestAnimationFrame(step);
    };
    wakeRef.current = wake;
    runningRef.current = true;
    raf = requestAnimationFrame(step);

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const next = zoomRef.current * Math.exp(-ev.deltaY * 0.0015);
      zoomRef.current = Math.min(4.5, Math.max(0.45, next));
      wake(); // a parked loop must resume to render the new zoom
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      if (glowTimer) clearTimeout(glowTimer);
      runningRef.current = false;
      wakeRef.current = null;
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphSig, height]);

  // A highlight/steady glow can appear (or colors shift with it) while the loop
  // is parked — wake it so the new state actually renders.
  useEffect(() => {
    wakeRef.current?.();
  }, [highlightIds, steadyIds]);

  // Parked-while-hidden loops resume when the window comes back.
  useEffect(
    () =>
      onWindowVisibility((hidden) => {
        if (!hidden) wakeRef.current?.();
      }),
    [],
  );

  const onMove = (ev: React.PointerEvent) => {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    mouseRef.current = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    wakeRef.current?.(); // need frames to update hover/tooltip
  };
  const onLeave = () => {
    mouseRef.current = null;
  };

  const onPointerDown = (ev: React.PointerEvent) => {
    ev.preventDefault();
    draggingRef.current = true;
    movedRef.current = false;
    wakeRef.current?.(); // a parked loop must resume to render the rotation
    let last = { x: ev.clientX, y: ev.clientY };
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'grabbing';
    const onDrag = (e: PointerEvent) => {
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true;
      last = { x: e.clientX, y: e.clientY };
      const rot = rotRef.current;
      rot.yaw += dx * 0.01;
      rot.pitch = Math.max(-1.45, Math.min(1.45, rot.pitch + dy * 0.01));
    };
    const onUp = () => {
      draggingRef.current = false;
      if (canvas) canvas.style.cursor = 'grab';
      window.removeEventListener('pointermove', onDrag);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onDrag);
    window.addEventListener('pointerup', onUp);
  };

  const onClick = () => {
    if (movedRef.current) return;
    const n = hoverRef.current;
    if (n && onNodeClick) onNodeClick(n);
  };

  const onDoubleClick = () => {
    rotRef.current = { yaw: 0.5, pitch: -0.28 };
    zoomRef.current = 1;
    wakeRef.current?.(); // render the reset view even if the loop was parked
  };

  return (
    <div className="argus-graph-wrap" ref={wrapRef} style={{ minHeight: height }}>
      <canvas
        ref={canvasRef}
        className="argus-graph-canvas"
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onPointerDown={onPointerDown}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      />
      <div className="argus-graph-hud argus-mono">drag · scroll · dbl-click</div>
      {tip && renderTooltip && (
        <div className="argus-graph-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          {renderTooltip(tip.node)}
        </div>
      )}
    </div>
  );
}
