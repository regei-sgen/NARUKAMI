// Persisted custom terminal-tab names, keyed by backend runId. Survives project
// switches, minimize, and reloads (localStorage). Kept small — names are cleared
// when their tab closes.
const KEY = 'narukami.termNames';

function readAll(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore quota / disabled storage */
  }
}

export function getTermName(runId: string): string | undefined {
  return readAll()[runId];
}

/** Store (trimmed) or, if blank, remove the custom name for a run. */
export function setTermName(runId: string, name: string): void {
  const map = readAll();
  const trimmed = name.trim();
  if (trimmed) map[runId] = trimmed;
  else delete map[runId];
  writeAll(map);
}

export function clearTermName(runId: string): void {
  const map = readAll();
  if (runId in map) {
    delete map[runId];
    writeAll(map);
  }
}
