import { prisma } from '../db';

/**
 * The observe half of the edit → run → observe loop.
 *
 * The desktop shell already attaches a CDP debugger to the Browser tab's preview
 * iframes and streams console + network events to the RENDERER, where a human
 * reads them. This module is the other end of that same pipe: the Electron main
 * process (which runs this backend in-process) also pushes the raw CDP messages
 * in here, where they are normalized and kept in a small per-project ring that
 * `GET /api/projects/:id/browser-logs` hands to an agent. That is the difference
 * between Claude editing a component blind and Claude reading the stack trace the
 * hot reload just produced.
 *
 * Deliberately memory-only — no Prisma model, no table. These are breadcrumbs
 * belonging to a live preview session, worthless an hour later, and the audit's
 * standing complaint about this codebase was state that is bounded in memory but
 * unbounded on disk. Every ceiling here is explicit: at most
 * BROWSER_LOG_PROJECT_MAX projects × BROWSER_LOG_RING_MAX events, each event's
 * text clipped to BROWSER_LOG_TEXT_MAX chars.
 */

/** Events retained per project. Mirrors the desktop capture buffer (PREVIEW_BUFFER_MAX = 300). */
export const BROWSER_LOG_RING_MAX = 300;
/** Projects tracked at once; the least-recently-WRITTEN is dropped past this. */
export const BROWSER_LOG_PROJECT_MAX = 8;
/** One console.log can be a serialized megabyte — clip before it lands in the ring. */
export const BROWSER_LOG_TEXT_MAX = 1000;
/** Urls are long but not unbounded (data: urls are). */
export const BROWSER_LOG_URL_MAX = 500;
/** In-flight requestId → url, so a loadingFailed can name what actually failed. */
const PENDING_REQUEST_MAX = 300;

/** Default / ceiling for a read. The route validates against these. */
export const BROWSER_LOG_LIMIT_DEFAULT = 200;
export const BROWSER_LOG_LIMIT_MAX = 300;

/**
 * The buckets a stored event lands in. `network` deliberately covers BOTH a
 * failed request and a >=400 response: an agent asking "what broke" wants those
 * together rather than split by which CDP method reported them.
 */
export type BrowserLogLevel = 'error' | 'warn' | 'info' | 'log' | 'network';
export const BROWSER_LOG_LEVELS: readonly BrowserLogLevel[] = [
  'error',
  'warn',
  'info',
  'log',
  'network',
];

export interface StoredBrowserEvent {
  /** Monotonic per project. A reader passes the last one back as `since`. */
  seq: number;
  ts: string;
  level: BrowserLogLevel;
  /** The originating CDP shape: `console.<type>` | exception | response | request-failed. */
  kind: string;
  text: string;
  url?: string;
  status?: number;
}

/**
 * A raw CDP message exactly as the desktop main process forwards it. Normalizing
 * happens HERE so main.ts stays a thin forwarder — it owns the debugger session
 * and the origin filter, nothing else.
 */
export interface BrowserLogEvent {
  method: string;
  params?: unknown;
}

export interface ReadBrowserEventsOptions {
  since?: number;
  level?: string;
  limit?: number;
}

interface ProjectLogs {
  events: StoredBrowserEvent[];
  /** Last seq handed out. Survives eviction and clear — see clearBrowserEvents. */
  seq: number;
  pending: Map<string, string>;
  writeOrder: number;
}

const byProject = new Map<string, ProjectLogs>();
// LRU ordering ticks off a counter rather than Date.now(): a burst of writes
// across several projects lands inside the same millisecond, which would make
// the wall clock unable to say which project is actually the oldest.
let writeTick = 0;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** CDP RemoteObject → short printable text, matching what the Browser panel shows. */
function remoteObjectText(o: unknown): string {
  const r = (o ?? {}) as { type?: string; value?: unknown; description?: string; unserializableValue?: string };
  if (r.unserializableValue !== undefined) return r.unserializableValue;
  if (r.value !== undefined) return typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value);
  return r.description ?? r.type ?? '?';
}

/**
 * console.<type> → level. CDP's `type` is the console method name, so assert
 * joins error (it only fires on a FAILED assertion) and everything decorative
 * (table, dir, trace, group…) collapses to plain log.
 */
function consoleLevel(type: string): BrowserLogLevel {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning') return 'warn';
  if (type === 'info') return 'info';
  return 'log';
}

function ensureProject(projectId: string): ProjectLogs {
  const existing = byProject.get(projectId);
  if (existing) return existing;
  // Evict the least-recently-written project first: a long session that cycles
  // through many projects must not grow this map forever.
  while (byProject.size >= BROWSER_LOG_PROJECT_MAX) {
    let oldestId: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, logs] of byProject) {
      if (logs.writeOrder < oldestAt) {
        oldestAt = logs.writeOrder;
        oldestId = id;
      }
    }
    if (oldestId === null) break;
    byProject.delete(oldestId);
  }
  const fresh: ProjectLogs = { events: [], seq: 0, pending: new Map(), writeOrder: 0 };
  byProject.set(projectId, fresh);
  return fresh;
}

function rememberRequest(logs: ProjectLogs, requestId: string, url: string): void {
  if (!requestId || !url) return;
  logs.pending.set(requestId, clip(url, BROWSER_LOG_URL_MAX));
  // Insertion-ordered, so the first key is the oldest in-flight request.
  while (logs.pending.size > PENDING_REQUEST_MAX) {
    const oldest = logs.pending.keys().next();
    if (oldest.done) break;
    logs.pending.delete(oldest.value);
  }
}

type NormalizedEvent = Omit<StoredBrowserEvent, 'seq' | 'ts'>;

/**
 * CDP message → flat stored event, or null for a message that is only
 * bookkeeping (requestWillBeSent) or plain noise (a 200 response). Successful
 * responses are dropped on purpose: the ring is 300 deep and a single page load
 * fires hundreds of them, which would evict the exception that matters.
 */
function normalize(ev: BrowserLogEvent, logs: ProjectLogs): NormalizedEvent | null {
  const p = (ev.params ?? {}) as Record<string, unknown>;
  switch (ev.method) {
    case 'Runtime.consoleAPICalled': {
      const type = String(p.type ?? 'log');
      const args = Array.isArray(p.args) ? p.args : [];
      return {
        level: consoleLevel(type),
        kind: `console.${type}`,
        text: clip(args.map(remoteObjectText).join(' '), BROWSER_LOG_TEXT_MAX),
      };
    }
    case 'Runtime.exceptionThrown': {
      const d = (p.exceptionDetails ?? {}) as { exception?: { description?: string }; text?: string };
      const text = d.exception?.description ?? d.text ?? 'Uncaught exception';
      return { level: 'error', kind: 'exception', text: clip(String(text), BROWSER_LOG_TEXT_MAX) };
    }
    case 'Network.requestWillBeSent': {
      const req = (p.request ?? {}) as { url?: unknown };
      rememberRequest(logs, String(p.requestId ?? ''), String(req.url ?? ''));
      return null;
    }
    case 'Network.responseReceived': {
      const res = (p.response ?? {}) as { status?: unknown; url?: unknown };
      const status = Number(res.status ?? 0);
      if (!Number.isFinite(status) || status < 400) return null;
      const url = String(res.url ?? '') || logs.pending.get(String(p.requestId ?? '')) || '';
      return {
        level: 'network',
        kind: 'response',
        text: `HTTP ${status}`,
        ...(url ? { url: clip(url, BROWSER_LOG_URL_MAX) } : {}),
        status,
      };
    }
    case 'Network.loadingFailed': {
      const requestId = String(p.requestId ?? '');
      const url = logs.pending.get(requestId) ?? '';
      logs.pending.delete(requestId);
      return {
        level: 'network',
        kind: 'request-failed',
        text: clip(String(p.errorText ?? 'failed'), BROWSER_LOG_TEXT_MAX),
        ...(url ? { url } : {}),
      };
    }
    default:
      return null;
  }
}

/** Push CDP messages into a project's ring. Returns how many became stored events. */
export function recordBrowserEvents(projectId: string, events: BrowserLogEvent[]): number {
  if (!projectId || !Array.isArray(events) || events.length === 0) return 0;
  const logs = ensureProject(projectId);
  writeTick += 1;
  logs.writeOrder = writeTick;
  let stored = 0;
  for (const ev of events) {
    if (!ev || typeof ev.method !== 'string') continue;
    const norm = normalize(ev, logs);
    if (!norm) continue;
    logs.seq += 1;
    logs.events.push({ seq: logs.seq, ts: new Date().toISOString(), ...norm });
    stored += 1;
  }
  if (logs.events.length > BROWSER_LOG_RING_MAX) {
    logs.events.splice(0, logs.events.length - BROWSER_LOG_RING_MAX);
  }
  return stored;
}

/**
 * Read a project's buffered events. `since` is a cursor, not a timestamp: only
 * events with a HIGHER seq come back, which is how a poller avoids re-reading.
 * `nextSeq` is the project's latest seq — NOT the last returned one — so a
 * caller filtering by level still advances past events it filtered out.
 */
export function readBrowserEvents(
  projectId: string,
  opts: ReadBrowserEventsOptions,
): { events: StoredBrowserEvent[]; nextSeq: number } {
  const since = Number.isFinite(opts.since) ? Math.max(0, Number(opts.since)) : 0;
  const rawLimit = Number.isFinite(opts.limit) ? Math.trunc(Number(opts.limit)) : BROWSER_LOG_LIMIT_DEFAULT;
  const limit = Math.min(BROWSER_LOG_LIMIT_MAX, Math.max(1, rawLimit));
  const logs = byProject.get(projectId);
  if (!logs) return { events: [], nextSeq: since };

  let out = logs.events.filter((e) => e.seq > since);
  if (opts.level) out = out.filter((e) => e.level === opts.level);
  // Over the limit, keep the NEWEST — a truncated read should show what just
  // broke, not the top of the buffer.
  if (out.length > limit) out = out.slice(out.length - limit);
  return { events: out, nextSeq: Math.max(logs.seq, since) };
}

/**
 * Drop a project's buffered events (a fresh preview session starts clean).
 *
 * The seq counter is deliberately NOT reset: a poller still holding a `since`
 * from before the clear would otherwise be handed seq numbers it has already
 * seen and would skip every new event.
 */
export function clearBrowserEvents(projectId: string): void {
  const logs = byProject.get(projectId);
  if (!logs) return;
  logs.events = [];
  logs.pending.clear();
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The persisted workspace UI blob, as /api/workspace stores it under key 'ui'. */
interface UiSettingsShape {
  selectedId?: unknown;
  browserUrlByProject?: unknown;
}

/**
 * Which project is this preview URL showing?
 *
 * The desktop shell's preview-watch IPC carries only a URL — the renderer never
 * tells main which project it is looking at — so the answer is reconstructed
 * from the workspace UI state the SPA already persists: `selectedId` (the Browser
 * tab only ever renders the SELECTED project) plus `browserUrlByProject` (what
 * that project's address bar was committed to). Preference order matters:
 * `selectedId` first when its stored url agrees, because the SPA's settings save
 * is debounced 300ms and a JUST-committed url may not be in the map yet, while
 * the selection is minutes old. A disagreement means the selection is the stale
 * half, so the url map wins.
 *
 * Returns null when nothing can be attributed — capture then stays renderer-only
 * rather than filing events under the wrong project.
 */
export async function previewProjectId(url: string): Promise<string | null> {
  if (typeof url !== 'string' || !url) return null;
  let ui: UiSettingsShape;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: 'ui' } });
    if (!row) return null;
    ui = JSON.parse(row.value) as UiSettingsShape;
  } catch {
    return null;
  }
  if (!ui || typeof ui !== 'object') return null;

  const selectedId = typeof ui.selectedId === 'string' && ui.selectedId ? ui.selectedId : null;
  const map =
    ui.browserUrlByProject && typeof ui.browserUrlByProject === 'object'
      ? (ui.browserUrlByProject as Record<string, unknown>)
      : {};
  const origin = originOf(url);

  const selectedUrl = selectedId ? map[selectedId] : undefined;
  if (typeof selectedUrl === 'string' && (selectedUrl === url || (origin && originOf(selectedUrl) === origin))) {
    return selectedId;
  }
  for (const [projectId, stored] of Object.entries(map)) {
    if (stored === url) return projectId;
  }
  if (origin) {
    for (const [projectId, stored] of Object.entries(map)) {
      if (typeof stored === 'string' && originOf(stored) === origin) return projectId;
    }
  }
  return selectedId;
}
