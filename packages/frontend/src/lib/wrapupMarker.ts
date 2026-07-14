// Wrap-up completion-marker scanning over a streamed pty output. The marker can
// arrive split across two ws chunks, so each scan carries the last marker-length-1
// characters forward. Pure (no time/gating logic — the caller owns the post-inject
// grace window) so it can be unit-tested against chunk-boundary cases.

export interface MarkerScan {
  found: boolean;
  carry: string;
}

export function scanForMarker(carry: string, chunk: string, marker: string): MarkerScan {
  const hay = carry + chunk;
  return {
    found: hay.includes(marker),
    carry: hay.slice(-(marker.length - 1)),
  };
}
