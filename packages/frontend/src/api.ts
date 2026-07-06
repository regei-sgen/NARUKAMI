import type {
  AnalyzerResult,
  EodEntry,
  FileContent,
  GitDiff,
  GitStatus,
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

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : undefined;

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

  saveFile: (projectId: string, filePath: string, content: string) =>
    request<{ ok: boolean; bytes: number }>(`/api/projects/${projectId}/file`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath, content }),
    }),

  // Case-insensitive content search across the project's files.
  searchCode: (projectId: string, q: string) =>
    request<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>(
      `/api/projects/${projectId}/search?q=${encodeURIComponent(q)}`,
    ),

  // Git working-tree status (changed files) for the file-tree change markers.
  getGitStatus: (projectId: string) => request<GitStatus>(`/api/projects/${projectId}/git/status`),

  // Changed line ranges for one file, for the editor's diff gutter.
  getGitDiff: (projectId: string, filePath: string) =>
    request<GitDiff>(`/api/projects/${projectId}/git/diff?path=${encodeURIComponent(filePath)}`),

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
