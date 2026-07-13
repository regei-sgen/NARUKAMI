// Pure math behind the header activity wave, split out of the canvas component
// so the amplitude/decay behaviour can be unit-tested without a DOM or an
// animation loop (this package's vitest runs in the node env — no canvas).

/** Intensity a single output chunk of `bytes` adds to the wave. Saturating, so
 *  one huge burst can't spike the wave past a per-chunk ceiling. 0 for no bytes. */
export function pulseAmount(bytes: number): number {
  if (!(bytes > 0)) return 0;
  return Math.min(0.5, 0.06 + bytes / 4000);
}

/** Add a chunk pulse to the current spike level, clamped to [0, 1]. */
export function addPulse(level: number, bytes: number): number {
  return Math.min(1, Math.max(0, level) + pulseAmount(bytes));
}

/**
 * Advance the spike level by one frame: decay toward zero, but never below the
 * sustained `floor` (non-zero while a process is in the "working" state, so the
 * wave stays alive between output chunks). Values below a small epsilon snap to
 * the floor, so a fully idle wave settles to a flat line instead of drifting.
 */
export function decayLevel(level: number, floor: number, decay = 0.94): number {
  const clampedFloor = Math.min(1, Math.max(0, floor));
  const decayed = Math.max(0, level) * decay;
  return Math.max(decayed < 0.004 ? 0 : decayed, clampedFloor);
}
