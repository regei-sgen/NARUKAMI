// Pure helpers for the per-viewport pop-out, kept free of any electron import so
// they can be unit-tested without launching the app. Consumed by main.ts.

export interface ViewportPopoutParams {
  projectId: string;
  browserId: string;
  vpId: string;
  pos?: { x: number; y: number };
}

// Registry key for a per-viewport window. Encodes project + browser tab +
// viewport so many can coexist, while re-opening the SAME device just focuses the
// existing window instead of spawning a duplicate. Kept in sync with the query
// string main.ts loads (`?popout=viewport&project=&browser=&vp=`).
export function viewportPopoutKey(projectId: string, browserId: string, vpId: string): string {
  return `${projectId}::${browserId}::${vpId}`;
}

// Validate the IPC payload sent from the renderer's `popOutViewport`. Returns
// null for anything malformed so a bad/hostile message can never spawn a junk
// window. `pos` (the drag-out cursor point) is optional and dropped unless both
// coordinates are finite numbers.
export function parseViewportPopoutParams(raw: unknown): ViewportPopoutParams | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as { projectId?: unknown; browserId?: unknown; vpId?: unknown; pos?: unknown };
  if (typeof p.projectId !== 'string' || !p.projectId) return null;
  if (typeof p.browserId !== 'string' || !p.browserId) return null;
  if (typeof p.vpId !== 'string' || !p.vpId) return null;

  let pos: { x: number; y: number } | undefined;
  if (p.pos && typeof p.pos === 'object' && 'x' in p.pos && 'y' in p.pos) {
    const x = Number((p.pos as { x: unknown }).x);
    const y = Number((p.pos as { y: unknown }).y);
    if (Number.isFinite(x) && Number.isFinite(y)) pos = { x, y };
  }
  return { projectId: p.projectId, browserId: p.browserId, vpId: p.vpId, pos };
}
