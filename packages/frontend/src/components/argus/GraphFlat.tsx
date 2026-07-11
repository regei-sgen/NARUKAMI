import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

/**
 * GraphFlat — a dependency-free, interactive 2D force-directed graph. Unlike
 * GraphGlobe (which pins nodes onto a rotating sphere), this lays the graph out
 * FLAT: repulsion + edge springs + a gentle centering pull. Interactions: drag
 * the background to pan, scroll to zoom (cursor-anchored), drag a node to move
 * (and pin) it, hover for a tooltip, click to select, double-click to reset.
 * Styled with NARUKAMI's default (red/black) design tokens via `mg-*` classes.
 */

export interface FlatNode {
  id: string;
  label: string;
  kind: string;
}
export interface FlatEdge {
  source: string;
  target: string;
  kind?: string;
  fuzzy?: boolean;
}
export interface P2 {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GraphFlatProps<T extends FlatNode = FlatNode> {
  nodes: T[];
  edges: FlatEdge[];
  height?: number;
  colorOf: (n: T) => string;
  radiusOf?: (n: T) => number;
  alphaOf?: (n: T) => number;
  /** Node ids that glow (e.g. the selected project). */
  highlightIds?: Set<string>;
  onNodeClick?: (n: T) => void;
  renderTooltip?: (n: T) => ReactNode;
  alwaysLabel?: (n: T) => boolean;
}

const REPULSION = 5200;
const SPRING = 0.045;
const SPRING_REST = 74;
const CENTER = 0.012;
const DAMPING = 0.82;
const THETA2 = 0.81; // Barnes–Hut opening angle θ=0.9, squared (d3-force's default)
const BH_MAX_DEPTH = 24; // stop subdividing near-coincident points (avoids infinite recursion)

/** A square Barnes–Hut quadtree cell: aggregate mass + center-of-mass, plus either
 *  a single body (leaf) or four children. */
interface BHCell {
  cx: number;
  cy: number;
  hw: number; // half-width of the square cell
  mass: number; // body count
  sx: number; // Σx  (center of mass = sx/mass)
  sy: number; // Σy
  bi: number; // body index if a single-body leaf, else -1
  bx: number;
  by: number;
  kids: BHCell[] | null;
}

function bhCell(cx: number, cy: number, hw: number): BHCell {
  return { cx, cy, hw, mass: 0, sx: 0, sy: 0, bi: -1, bx: 0, by: 0, kids: null };
}

function bhQuad(cell: BHCell, x: number, y: number): BHCell {
  // kids order: [NW, NE, SW, SE]; index = (south ? 2 : 0) + (east ? 1 : 0)
  const east = x >= cell.cx ? 1 : 0;
  const south = y >= cell.cy ? 1 : 0;
  return cell.kids![south * 2 + east];
}

function bhInsert(cell: BHCell, i: number, x: number, y: number, depth: number): void {
  if (cell.mass === 0) {
    cell.mass = 1;
    cell.sx = x;
    cell.sy = y;
    cell.bi = i;
    cell.bx = x;
    cell.by = y;
    return;
  }
  // Near-coincident points at max depth: stop subdividing, keep them as one cluster.
  if (depth >= BH_MAX_DEPTH) {
    cell.mass += 1;
    cell.sx += x;
    cell.sy += y;
    cell.bi = -1;
    return;
  }
  if (!cell.kids) {
    const q = cell.hw / 2;
    cell.kids = [
      bhCell(cell.cx - q, cell.cy - q, q),
      bhCell(cell.cx + q, cell.cy - q, q),
      bhCell(cell.cx - q, cell.cy + q, q),
      bhCell(cell.cx + q, cell.cy + q, q),
    ];
    if (cell.bi >= 0) {
      bhInsert(bhQuad(cell, cell.bx, cell.by), cell.bi, cell.bx, cell.by, depth + 1);
      cell.bi = -1;
    }
  }
  cell.mass += 1;
  cell.sx += x;
  cell.sy += y;
  bhInsert(bhQuad(cell, x, y), i, x, y, depth + 1);
}

/** Accumulate the repulsion on body i from a cell, opening it into children only
 *  when it is too close/large to approximate as one point mass (θ criterion). */
function bhForce(cell: BHCell, i: number, x: number, y: number, alpha: number, out: { fx: number; fy: number }): void {
  if (cell.mass === 0) return;
  const comx = cell.sx / cell.mass;
  const comy = cell.sy / cell.mass;
  let dx = x - comx;
  let dy = y - comy;
  let d2 = dx * dx + dy * dy;
  const w = 2 * cell.hw;
  if (cell.kids === null || w * w < THETA2 * d2) {
    if (cell.bi === i) return; // don't repel a body from itself
    if (d2 < 1) {
      // coincident: nudge in a per-body deterministic direction
      dx = (i % 7) * 0.5 + 0.1;
      dy = 0.1;
      d2 = dx * dx + dy * dy;
    }
    const d = Math.sqrt(d2);
    const f = (REPULSION * alpha * cell.mass) / d2;
    out.fx += (dx / d) * f;
    out.fy += (dy / d) * f;
    return;
  }
  const kids = cell.kids;
  bhForce(kids[0], i, x, y, alpha, out);
  bhForce(kids[1], i, x, y, alpha, out);
  bhForce(kids[2], i, x, y, alpha, out);
  bhForce(kids[3], i, x, y, alpha, out);
}

/**
 * One 2D force step (Barnes–Hut repulsion + edge springs + centering), mutating
 * `pos` velocities/positions in place. Pinned ids are held fixed. Pure
 * (deterministic, no I/O) so the layout physics is unit-testable.
 */
export function layoutStep<T extends FlatNode>(
  nodes: T[],
  edges: FlatEdge[],
  pos: Map<string, P2>,
  alpha: number,
  pinned: Set<string>,
): void {
  // Repulsion via a Barnes–Hut quadtree — O(n log n) per tick instead of the
  // all-pairs O(n²) that froze large graphs. Build the tree over current
  // positions, then accumulate each body's force by opening only nearby cells.
  const N = nodes.length;
  if (N > 1) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < N; i += 1) {
      const p = pos.get(nodes[i].id);
      if (!p) continue;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (minX <= maxX) {
      const root = bhCell((minX + maxX) / 2, (minY + maxY) / 2, Math.max(maxX - minX, maxY - minY, 1) / 2 + 1);
      for (let i = 0; i < N; i += 1) {
        const p = pos.get(nodes[i].id);
        if (p) bhInsert(root, i, p.x, p.y, 0);
      }
      const out = { fx: 0, fy: 0 };
      for (let i = 0; i < N; i += 1) {
        const p = pos.get(nodes[i].id);
        if (!p) continue;
        out.fx = 0;
        out.fy = 0;
        bhForce(root, i, p.x, p.y, alpha, out);
        p.vx += out.fx;
        p.vy += out.fy;
      }
    }
  }
  for (const e of edges) {
    const ps = pos.get(e.source);
    const pt = pos.get(e.target);
    if (!ps || !pt) continue;
    const dx = pt.x - ps.x;
    const dy = pt.y - ps.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = ((d - SPRING_REST) / d) * SPRING * alpha;
    ps.vx += dx * f;
    ps.vy += dy * f;
    pt.vx -= dx * f;
    pt.vy -= dy * f;
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    if (pinned.has(n.id)) {
      p.vx = 0;
      p.vy = 0;
      continue;
    }
    p.vx += -p.x * CENTER * alpha;
    p.vy += -p.y * CENTER * alpha;
    p.vx *= DAMPING;
    p.vy *= DAMPING;
    p.x += p.vx;
    p.y += p.vy;
  }
}

/** World → screen. Pure. */
export function project2d(
  p: { x: number; y: number },
  W: number,
  H: number,
  pan: { x: number; y: number },
  zoom: number,
): { sx: number; sy: number } {
  return { sx: W / 2 + p.x * zoom + pan.x, sy: H / 2 + p.y * zoom + pan.y };
}

/** Nearest node under `mouse` within its (zoom-scaled) radius, else null. Pure. */
export function hitTest2d<T extends FlatNode>(
  nodes: T[],
  scr: Map<string, { sx: number; sy: number }>,
  mouse: { x: number; y: number },
  radiusOf: (n: T) => number,
  zoom: number,
): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const n of nodes) {
    const s = scr.get(n.id);
    if (!s) continue;
    const rr = Math.max(4, radiusOf(n) * zoom) + 5;
    const dx = s.sx - mouse.x;
    const dy = s.sy - mouse.y;
    const dd = dx * dx + dy * dy;
    if (dd <= rr * rr && dd < bestD) {
      bestD = dd;
      best = n;
    }
  }
  return best;
}

export function GraphFlat<T extends FlatNode = FlatNode>({
  nodes,
  edges,
  height = 540,
  colorOf,
  radiusOf,
  alphaOf,
  highlightIds,
  onNodeClick,
  renderTooltip,
  alwaysLabel,
}: GraphFlatProps<T>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<Map<string, P2>>(new Map());
  const pinnedRef = useRef<Set<string>>(new Set());
  const alphaRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const draggingNodeRef = useRef<string | null>(null);
  const panningRef = useRef(false);
  const movedRef = useRef(false);
  const hoverRef = useRef<T | null>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const runningRef = useRef(false); // is the rAF loop currently scheduled?
  const wakeRef = useRef<(() => void) | null>(null); // restart the loop from outside the effect
  const [tip, setTip] = useState<{ x: number; y: number; node: T } | null>(null);
  const tipRef = useRef<typeof tip>(null);
  tipRef.current = tip;

  const cbRef = useRef({ colorOf, radiusOf, alphaOf, highlightIds, alwaysLabel });
  cbRef.current = { colorOf, radiusOf, alphaOf, highlightIds, alwaysLabel };

  const graphSig = useMemo(() => `${nodes.map((n) => n.id).join('|')}#${edges.length}`, [nodes, edges]);

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
    const sizeCanvas = () => {
      W = wrap.clientWidth || 800;
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
    for (const id of [...pinnedRef.current]) if (!seen.has(id)) pinnedRef.current.delete(id);
    // Seed new nodes on a golden-angle spiral so the sim untangles cleanly.
    nodes.forEach((n, i) => {
      if (pos.has(n.id)) return;
      const ang = i * 2.399963229728653;
      const rad = 14 * Math.sqrt(i + 1);
      pos.set(n.id, { x: rad * Math.cos(ang), y: rad * Math.sin(ang), vx: 0, vy: 0 });
    });

    const radius = (n: T) => cbRef.current.radiusOf?.(n) ?? 5;

    let raf = 0;
    let glowTimer: ReturnType<typeof setTimeout> | null = null;
    let tick = 0;
    const step = () => {
      tick += 1;
      const alpha = alphaRef.current;
      if (alpha > 0.02) {
        layoutStep(nodes, edges, pos, alpha, pinnedRef.current);
        alphaRef.current = alpha * 0.985;
      }

      const pan = panRef.current;
      const zoom = zoomRef.current;
      const scr = new Map<string, { sx: number; sy: number }>();
      for (const n of nodes) scr.set(n.id, project2d(pos.get(n.id)!, W, H, pan, zoom));

      const m = mouseRef.current;
      const hover = m && !panningRef.current && !draggingNodeRef.current ? hitTest2d(nodes, scr, m, radius, zoom) : null;
      hoverRef.current = hover;

      ctx.clearRect(0, 0, W, H);

      const highlight = cbRef.current.highlightIds;
      const hasGlow = !!highlight && highlight.size > 0;
      const isGlow = (id: string) => !!highlight?.has(id);

      // edges
      for (const e of edges) {
        const a = scr.get(e.source);
        const b = scr.get(e.target);
        if (!a || !b) continue;
        const live = isGlow(e.source) && isGlow(e.target);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        if (e.fuzzy) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = 'rgba(255,176,32,0.35)';
        } else {
          ctx.setLineDash([]);
          ctx.strokeStyle = live ? 'rgba(255,45,60,0.55)' : 'rgba(138,138,151,0.22)';
        }
        ctx.lineWidth = live ? 1.5 : 1;
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const pulse = 0.5 + 0.5 * Math.sin(tick * 0.09);
      for (const n of nodes) {
        const s = scr.get(n.id)!;
        const glow = isGlow(n.id);
        const r = Math.max(2, radius(n) * zoom * (glow ? 1.25 : 1));
        const color = cbRef.current.colorOf(n);
        let a = cbRef.current.alphaOf?.(n) ?? 1;
        if (hasGlow && !glow) a *= 0.4;

        if (glow) {
          // Pulsing ring/halo is tinted to the NODE's own colour (not a fixed red).
          ctx.globalAlpha = (0.22 + 0.34 * pulse) * a;
          ctx.beginPath();
          ctx.arc(s.sx, s.sy, r + 5 + 3 * pulse, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.shadowColor = color;
          ctx.shadowBlur = 14;
        }
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(s.sx, s.sy, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.shadowBlur = 0;

        if (hover === n) {
          ctx.globalAlpha = 1;
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        const wantLabel = hover === n || glow || cbRef.current.alwaysLabel?.(n);
        if (wantLabel) {
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = 'rgba(232,232,238,0.92)';
          ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
          ctx.fillText(n.label.slice(0, 26), s.sx + r + 4, s.sy + 3);
          ctx.globalAlpha = 1;
        }
      }

      if (m && hover) setTip({ x: m.x, y: m.y, node: hover });
      else if (tipRef.current) setTip(null);

      // Idle-stop: keep animating at full rate only while the layout is still
      // settling or the user is interacting. A settled graph whose only motion
      // is the pulsing highlight halo doesn't need 60fps — throttle it to
      // ~12fps (a slow sine reads identically) so an always-glowing selection
      // can't pin a full-canvas redraw loop while other views do real work.
      // Otherwise park the loop at ~0 CPU until wake() reschedules it.
      const interacting =
        alphaRef.current > 0.02 ||
        !!mouseRef.current ||
        draggingNodeRef.current !== null ||
        panningRef.current;
      const glowOnly = !interacting && !!highlight && highlight.size > 0;
      if (interacting) raf = requestAnimationFrame(step);
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
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const pan = panRef.current;
      const z0 = zoomRef.current;
      const z1 = Math.min(4.5, Math.max(0.3, z0 * Math.exp(-ev.deltaY * 0.0015)));
      // keep the world point under the cursor fixed while zooming
      const wx = (mx - W / 2 - pan.x) / z0;
      const wy = (my - H / 2 - pan.y) / z0;
      pan.x = mx - W / 2 - wx * z1;
      pan.y = my - H / 2 - wy * z1;
      zoomRef.current = z1;
      wake();
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

  // A highlight (changed/editing node) can appear while the loop is parked — wake it
  // so the new glow/pulse actually renders.
  useEffect(() => {
    wakeRef.current?.();
  }, [highlightIds]);

  const localMouse = (ev: React.PointerEvent): { x: number; y: number } => {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const onMove = (ev: React.PointerEvent) => {
    mouseRef.current = localMouse(ev);
    wakeRef.current?.(); // need frames to update hover/tooltip
  };
  const onLeave = () => {
    mouseRef.current = null;
  };

  const onPointerDown = (ev: React.PointerEvent) => {
    ev.preventDefault();
    movedRef.current = false;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const W = wrap.clientWidth || 800;
    const H = height;
    const mouse = localMouse(ev);
    const scr = new Map<string, { sx: number; sy: number }>();
    for (const n of nodes) scr.set(n.id, project2d(posRef.current.get(n.id)!, W, H, panRef.current, zoomRef.current));
    const hit = hitTest2d(nodes, scr, mouse, (n) => cbRef.current.radiusOf?.(n) ?? 5, zoomRef.current);

    if (hit) {
      draggingNodeRef.current = hit.id;
      pinnedRef.current.add(hit.id);
    } else {
      panningRef.current = true;
    }
    canvas.style.cursor = 'grabbing';
    wakeRef.current?.(); // a parked loop must resume to render the drag/pan
    let last = { x: ev.clientX, y: ev.clientY };

    const onDrag = (e: PointerEvent) => {
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true;
      last = { x: e.clientX, y: e.clientY };
      if (draggingNodeRef.current) {
        const p = posRef.current.get(draggingNodeRef.current);
        if (p) {
          const rect = canvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          p.x = (mx - W / 2 - panRef.current.x) / zoomRef.current;
          p.y = (my - H / 2 - panRef.current.y) / zoomRef.current;
          p.vx = 0;
          p.vy = 0;
        }
      } else if (panningRef.current) {
        panRef.current.x += dx;
        panRef.current.y += dy;
      }
    };
    const onUp = () => {
      draggingNodeRef.current = null;
      panningRef.current = false;
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
    panRef.current = { x: 0, y: 0 };
    zoomRef.current = 1;
    pinnedRef.current.clear();
    alphaRef.current = 1;
    wakeRef.current?.(); // reheated the sim — resume rendering
  };

  return (
    <div className="mg-graph-wrap" ref={wrapRef} style={{ minHeight: height }}>
      <canvas
        ref={canvasRef}
        className="mg-graph-canvas"
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onPointerDown={onPointerDown}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      />
      <div className="mg-graph-hud">drag · scroll · drag node · dbl-click resets</div>
      {tip && renderTooltip && (
        <div className="mg-graph-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          {renderTooltip(tip.node)}
        </div>
      )}
    </div>
  );
}
