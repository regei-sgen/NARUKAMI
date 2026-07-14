// Pure helpers for the "Changelog" view: a dated list of the app's git commits
// filtered by a date/time range. Kept out of the component so the range math is
// unit-testable without a DOM.

export interface LogCommit {
  date: string; // author date, ISO 8601
  author: string;
  hash: string;
  subject: string;
  body: string;
  filesChanged: number | null;
}

export type Preset = 'all' | 'today' | '24h' | '7d';

const DAY = 86_400_000;

// The [from, to] epoch-ms bounds for a quick preset. `null` means unbounded.
export function rangeForPreset(
  preset: Preset,
  nowMs: number,
): { fromMs: number | null; toMs: number | null } {
  switch (preset) {
    case '24h':
      return { fromMs: nowMs - DAY, toMs: nowMs };
    case '7d':
      return { fromMs: nowMs - 7 * DAY, toMs: nowMs };
    case 'today': {
      const d = new Date(nowMs);
      d.setHours(0, 0, 0, 0); // local midnight
      return { fromMs: d.getTime(), toMs: nowMs };
    }
    case 'all':
    default:
      return { fromMs: null, toMs: null };
  }
}

// Keep commits whose author date falls within [fromMs, toMs] (either bound may be
// null = unbounded). An unparseable date is kept rather than silently dropped.
export function filterCommits(
  commits: LogCommit[],
  fromMs: number | null,
  toMs: number | null,
): LogCommit[] {
  return commits.filter((c) => {
    const t = Date.parse(c.date);
    if (Number.isNaN(t)) return true;
    if (fromMs != null && t < fromMs) return false;
    if (toMs != null && t > toMs) return false;
    return true;
  });
}

// epoch ms → a datetime-local <input> value ("YYYY-MM-DDTHH:mm", local time).
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// A datetime-local <input> value → epoch ms (local), or null when empty/invalid.
export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}
