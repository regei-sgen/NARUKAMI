import type {
  AnalyzerResult,
  EodEntry,
  FileContent,
  Project,
  ProjectTree,
  RestoredRun,
  RunCommand,
  UiSettings,
  WorkspaceState,
} from './types';

// In the packaged desktop app the backend serves this SPA and injects the token
// (window.__NARUKAMI__) — so we talk to it same-origin. In dev (Vite on :5173)
// we fall back to the loopback backend on :4000 + the build-time env token.
const injected = (window as unknown as { __NARUKAMI__?: { token?: string } }).__NARUKAMI__;
const SAME_ORIGIN = injected ? window.location.origin : null;

const API_BASE = SAME_ORIGIN ?? 'http://127.0.0.1:4000';
const WS_BASE = SAME_ORIGIN ? SAME_ORIGIN.replace(/^http/, 'ws') : 'ws://127.0.0.1:4000';

const TOKEN = injected?.token ?? (import.meta.env.VITE_RUNNER_TOKEN as string | undefined);

export function hasToken(): boolean {
  return Boolean(TOKEN && TOKEN.length > 0 && TOKEN !== 'paste-the-token-here');
}

export function runWsUrl(runId: string): string {
  return `${WS_BASE}/ws/runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(TOKEN ?? '')}`;
}

interface ErrorBody {
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN ?? ''}`,
      ...(init?.headers ?? {}),
    },
  });

  if (res.status === 204) return undefined as T;

  // Parse defensively: a non-2xx response can carry a NON-JSON body (an HTML 500
  // page, a proxy error). Parsing before the res.ok check, unguarded, threw a raw
  // SyntaxError instead of the intended "Request failed (500)" message.
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const message = (body as ErrorBody | undefined)?.error ?? `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),

  addProject: (path: string) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  deleteProject: (id: string) =>
    request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  analyze: (id: string) =>
    request<{ project: Project; analysis: AnalyzerResult }>(
      `/api/projects/${id}/analyze`,
      { method: 'POST' },
    ),

  addCommand: (projectId: string, body: { label: string; command: string; isDefault?: boolean }) =>
    request<RunCommand>(`/api/projects/${projectId}/commands`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  suggestCommand: (projectId: string, requestText: string, isDefault?: boolean) =>
    request<RunCommand>(`/api/projects/${projectId}/commands/suggest`, {
      method: 'POST',
      body: JSON.stringify({ request: requestText, isDefault }),
    }),

  deleteCommand: (commandId: string) =>
    request<void>(`/api/commands/${commandId}`, { method: 'DELETE' }),

  run: (projectId: string, commandId: string) =>
    request<{ runId: string; pid: number }>(`/api/projects/${projectId}/run`, {
      method: 'POST',
      body: JSON.stringify({ commandId }),
    }),

  // admin: open an ELEVATED shell (Windows) — fires UAC; goes live once the
  // elevated broker connects back. `pid` is absent until then.
  openShell: (projectId: string, admin = false) =>
    request<{ runId: string; pid?: number; elevated?: boolean; pending?: boolean }>(
      `/api/projects/${projectId}/shell`,
      { method: 'POST', body: JSON.stringify({ admin }) },
    ),

  // Run details + liveness (used to poll a pending elevated shell until it's live).
  getRun: (runId: string) =>
    request<{
      id: string;
      status: string;
      exitCode: number | null;
      live: boolean;
      logs?: { chunk: string }[];
    }>(`/api/runs/${runId}`),

  // resume: reopen the most recent conversation in the project dir (claude --continue).
  openClaude: (projectId: string, opts: { effort?: string; resume?: boolean } = {}) =>
    request<{ runId: string; pid: number }>(`/api/projects/${projectId}/claude`, {
      method: 'POST',
      body: JSON.stringify(
        opts.resume ? { continue: true } : { effort: opts.effort ?? 'ultracode' },
      ),
    }),

  stopRun: (runId: string) =>
    request<{ ok: boolean; stopped: boolean }>(`/api/runs/${runId}/stop`, {
      method: 'POST',
    }),

  // --- built-in code editor ---
  getTree: (projectId: string) => request<ProjectTree>(`/api/projects/${projectId}/tree`),

  readFile: (projectId: string, filePath: string) =>
    request<FileContent>(
      `/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`,
    ),

  // baseMtimeMs = the file's mtime when it was opened; the backend rejects the
  // save with 409 if the file changed on disk since (last-write-wins guard).
  // force=true overwrites regardless (used after the user acknowledges the conflict).
  saveFile: (
    projectId: string,
    filePath: string,
    content: string,
    baseMtimeMs?: number,
    force = false,
  ) =>
    request<{ ok: boolean; bytes: number; mtimeMs: number }>(`/api/projects/${projectId}/file`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath, content, baseMtimeMs: force ? undefined : baseMtimeMs }),
    }),

  // Case-insensitive content search across the project's files.
  searchCode: (projectId: string, q: string) =>
    request<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>(
      `/api/projects/${projectId}/search?q=${encodeURIComponent(q)}`,
    ),

  // --- workspace / session restore ---
  getWorkspace: () => request<WorkspaceState>('/api/workspace'),

  closeRun: (runId: string) =>
    request<{ ok: boolean; stopped: boolean }>(`/api/runs/${runId}/close`, { method: 'POST' }),

  renameRun: (runId: string, name: string) =>
    request<{ ok: boolean; name: string | null }>(`/api/runs/${runId}/name`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  // resume: for a Claude tab, continue the last conversation instead of a fresh session.
  restartRun: (runId: string, resume = false) =>
    request<RestoredRun>(`/api/runs/${runId}/restart`, {
      method: 'POST',
      ...(resume ? { body: JSON.stringify({ continue: true }) } : {}),
    }),

  // --- end-of-day snapshots ---
  listEod: (projectId: string) => request<EodEntry[]>(`/api/projects/${projectId}/eod`),

  compileEod: (projectId: string, note?: string) =>
    request<EodEntry>(`/api/projects/${projectId}/eod/compile`, {
      method: 'POST',
      body: JSON.stringify(note !== undefined ? { note } : {}),
    }),

  updateEodNote: (eodId: string, note: string) =>
    request<EodEntry>(`/api/eod/${eodId}/note`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  summarizeEod: (eodId: string) =>
    request<EodEntry>(`/api/eod/${eodId}/summarize`, { method: 'POST' }),

  deleteEod: (eodId: string) =>
    request<{ ok: boolean }>(`/api/eod/${eodId}`, { method: 'DELETE' }),

  saveSettings: (patch: { ui?: UiSettings } & Record<string, unknown>) =>
    request<{ ok: boolean; saved: number }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
};
