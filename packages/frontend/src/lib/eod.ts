import type { EodItem } from '../types';

/** Local 'YYYY-MM-DD' key for today (matches the backend's day key). */
export function todayKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** A run counts as "ok" only if it exited cleanly (no signal/error, exit 0). */
export function isOk(it: EodItem): boolean {
  return it.status === 'exited' && (it.exitCode == null || it.exitCode === 0);
}

/** CSS status bucket for an item: ok (green) | warn (killed) | err (else). */
export function statusClass(it: EodItem): string {
  if (isOk(it)) return 'ok';
  if (it.status === 'killed') return 'warn';
  return 'err';
}

/** Human duration: ms → "850ms" / "45s" / "3m 10s" / "2m". */
export function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

/** Local HH:MM for an ISO timestamp (empty string for null). */
export function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface DayStats {
  total: number;
  ok: number;
  failed: number;
  activeMs: number; // summed run durations
  spanStart: string | null;
  spanEnd: string | null;
  byKind: Record<string, number>;
}

/** Roll a day's items into the summary stats shown in the EOD strip. */
export function computeStats(items: EodItem[]): DayStats {
  const s: DayStats = {
    total: items.length,
    ok: 0,
    failed: 0,
    activeMs: 0,
    spanStart: null,
    spanEnd: null,
    byKind: {},
  };
  for (const it of items) {
    if (isOk(it)) s.ok += 1;
    else s.failed += 1;
    if (it.durationMs != null) s.activeMs += it.durationMs;
    s.byKind[it.kind] = (s.byKind[it.kind] ?? 0) + 1;
    if (it.startedAt && (!s.spanStart || it.startedAt < s.spanStart)) s.spanStart = it.startedAt;
    if (it.endedAt && (!s.spanEnd || it.endedAt > s.spanEnd)) s.spanEnd = it.endedAt;
  }
  return s;
}
