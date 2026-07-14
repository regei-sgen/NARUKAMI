import type {
  AnalyzerResult,
  ArgusLogResult,
  ArgusSessions,
  ArgusStatus,
  Armory,
  CodeChanges,
  CodeEngineStatus,
  CodeGraph,
  CodeNodeDetail,
  CodeScope,
  EmbeddedGodAction,
  EmbeddedGodStatus,
  EodActiveResponse,
  EodReportDoc,
  FileContent,
  FileHead,
  GitBranch,
  GitChanges,
  GitDiff,
  GitStatus,
  MemoryGraph,
  MobileDeviceInfo,
  MobileRunInfo,
  PublicShare,
  ShareResult,
  MemoryNoteDetail,
  Project,
  ProjectTree,
  ReleaseCommitResult,
  ReleaseDoc,
  ReleasePreflight,
  ReleasePushResult,
  ReleaseZipDirResult,
  RestoredRun,
  RunCommand,
  UiSettings,
  VitalsFeed,
  WorkspaceState,
} from './types';

// In the packaged desktop app the backend serves this SPA and injects the token
// (window.__NARUKAMI__) — so we talk to it same-origin. In dev (Vite on :5173)
// we fall back to the loopback backend on :4000 + the build-time env token.
const injected =
  typeof window !== 'undefined'
    ? (window as unknown as { __NARUKAMI__?: { token?: string } }).__NARUKAMI__
    : undefined;
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
  // shell: 'cmd' opens cmd.exe instead of PowerShell (non-admin only).
  openShell: (projectId: string, admin = false, shell: 'powershell' | 'cmd' = 'powershell') =>
    request<{ runId: string; pid?: number; elevated?: boolean; pending?: boolean }>(
      `/api/projects/${projectId}/shell`,
      { method: 'POST', body: JSON.stringify({ admin, shell }) },
    ),

  // Flip which Windows shell a run command executes in (the PS/CMD toggle).
  setCommandShell: (commandId: string, shell: 'powershell' | 'cmd') =>
    request<RunCommand>(`/api/commands/${commandId}`, {
      method: 'PATCH',
      body: JSON.stringify({ shell }),
    }),

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

  // --- editor git integration (read-only) ---
  getGitBranch: (projectId: string) => request<GitBranch>(`/api/projects/${projectId}/git/branch`),

  getFileHead: (projectId: string, filePath: string) =>
    request<FileHead>(`/api/projects/${projectId}/git/file-head?path=${encodeURIComponent(filePath)}`),

  // Git working-tree status (changed files) for the file-tree change markers.
  getGitStatus: (projectId: string) => request<GitStatus>(`/api/projects/${projectId}/git/status`),

  // Changed line ranges for one file, for the editor's diff gutter.
  getGitDiff: (projectId: string, filePath: string) =>
    request<GitDiff>(`/api/projects/${projectId}/git/diff?path=${encodeURIComponent(filePath)}`),

  // --- editor git source control (Changes tab) ---
  getGitChanges: (projectId: string) =>
    request<GitChanges>(`/api/projects/${projectId}/git/changes`),

  stageFile: (projectId: string, filePath: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/git/stage`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath }),
    }),

  unstageFile: (projectId: string, filePath: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/git/unstage`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath }),
    }),

  discardFile: (projectId: string, filePath: string, untracked: boolean) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/git/discard`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath, untracked }),
    }),

  commitChanges: (projectId: string, message: string) =>
    request<{ ok: boolean; head: string }>(`/api/projects/${projectId}/git/commit`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  stageAll: (projectId: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/git/stage-all`, { method: 'POST' }),

  unstageAll: (projectId: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/git/unstage-all`, { method: 'POST' }),

  // --- changelog (this app's own commit history, for the Changelog view) ---
  getChangelog: () =>
    request<{ commits: import('./lib/changelog').LogCommit[] }>('/api/changelog'),

  // --- workspace / session restore ---
  getWorkspace: () => request<WorkspaceState>('/api/workspace'),

  // Header Instrument Cluster feed: process vitals + account usage windows.
  getVitals: () => request<VitalsFeed>('/api/vitals'),

  // Open a detected local dev-server URL in the system default browser.
  openUrl: (url: string) =>
    request<{ ok: boolean; url: string }>('/api/open-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  closeRun: (runId: string) =>
    request<{ ok: boolean; stopped: boolean }>(`/api/runs/${runId}/close`, { method: 'POST' }),

  // Record a claude tab's session wrap-up verdict (+ optional notes) server-side
  // BEFORE the close/stop proceeds — deterministic capture that survives whatever
  // the session does with the injected wrap-up prompt.
  wrapup: (runId: string, verdict: string, notes: string) =>
    request<{ ok: boolean; verdict: string }>(`/api/runs/${runId}/wrapup`, {
      method: 'POST',
      body: JSON.stringify({ verdict, notes }),
    }),

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

  // --- mobile LAN share (desktop side — master-token-gated) ---
  // Create a QR share for one live terminal → { url, relay, expiresAt, ... }.
  shareRun: (runId: string, opts: { canInput?: boolean; ttlMs?: number } = {}) =>
    request<ShareResult>(`/api/runs/${runId}/share`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  listShares: () =>
    request<{
      shares: PublicShare[];
      relay: { host: string; port: number } | null;
      devices: MobileDeviceInfo[];
    }>('/api/shares'),
  revokeShare: (id: string) => request<{ ok: boolean }>(`/api/shares/${id}`, { method: 'DELETE' }),
  // Allow or deny (deny also kicks) a phone that knocked on a shared terminal.
  setDeviceApproval: (runId: string, deviceId: string, action: 'allow' | 'deny') =>
    request<{ device: MobileDeviceInfo }>(
      `/api/runs/${encodeURIComponent(runId)}/devices/${encodeURIComponent(deviceId)}`,
      { method: 'POST', body: JSON.stringify({ action }) },
    ),

  // --- end-of-day reports (cross-project, over a single day or a date range) ---
  getEodActive: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to ?? from) qs.set('to', to ?? (from as string));
    const q = qs.toString();
    return request<EodActiveResponse>(`/api/eod/active${q ? `?${q}` : ''}`);
  },

  generateEodReport: (from: string, to: string, paths: string[], note?: string) =>
    request<EodReportDoc>('/api/eod/report', {
      method: 'POST',
      body: JSON.stringify({ from, to, paths, note }),
    }),

  listEodReports: () => request<EodReportDoc[]>('/api/eod/reports'),

  getEodReport: (id: string) => request<EodReportDoc>(`/api/eod/reports/${id}`),

  deleteEodReport: (id: string) =>
    request<{ ok: boolean }>(`/api/eod/reports/${id}`, { method: 'DELETE' }),

  // --- SGA Release (one-click release-zip + AI patch notes for the SGA repo) ---
  releasePreflight: (projectId: string) =>
    request<ReleasePreflight>(`/api/projects/${projectId}/release/preflight`),

  createRelease: (projectId: string, body: { version?: string; includeDirty?: boolean }) =>
    request<ReleaseDoc>(`/api/projects/${projectId}/release`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  generateReleaseNotes: (releaseId: string) =>
    request<ReleaseDoc>(`/api/releases/${releaseId}/notes`, { method: 'POST' }),

  listReleases: (projectId: string) => request<ReleaseDoc[]>(`/api/projects/${projectId}/releases`),

  // Commit the version bump (only the 3 version files, automatic message).
  commitRelease: (projectId: string) =>
    request<ReleaseCommitResult>(`/api/projects/${projectId}/release/commit`, { method: 'POST' }),

  // Push the current branch (creates the origin upstream on first push).
  pushRelease: (projectId: string) =>
    request<ReleasePushResult>(`/api/projects/${projectId}/release/push`, { method: 'POST' }),

  // Persist the permanent zip output folder ('' resets to the home-dir default).
  setReleaseZipDir: (dir: string) =>
    request<ReleaseZipDirResult>('/api/release/zip-dir', {
      method: 'POST',
      body: JSON.stringify({ dir }),
    }),

  deleteRelease: (releaseId: string) =>
    request<{ ok: boolean }>(`/api/releases/${releaseId}`, { method: 'DELETE' }),

  saveSettings: (patch: { ui?: UiSettings } & Record<string, unknown>) =>
    request<{ ok: boolean; saved: number }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),

  // --- Argus Panoptes (read-only god-monitor over ~/.claude) ---
  getArgusStatus: () => request<ArgusStatus>('/api/argus/status'),

  getArgusSessions: () => request<ArgusSessions>('/api/argus/sessions'),

  getArgusMemoryGraph: () => request<MemoryGraph>('/api/argus/memory-graph'),

  getArgusNote: (project: string, slug: string) =>
    request<MemoryNoteDetail>(
      `/api/argus/memory/note?project=${encodeURIComponent(project)}&slug=${encodeURIComponent(slug)}`,
    ),

  getArgusLogs: (source: 'monitor' | 'perf' | 'audit', limit = 200) =>
    request<ArgusLogResult>(
      `/api/argus/logs?source=${encodeURIComponent(source)}&limit=${limit}`,
    ),

  // --- Embedded godclaude (NARUKAMI's OWN instance — writable control plane) ---
  getGodStatus: () => request<EmbeddedGodStatus>('/api/godclaude/status'),

  godInstall: () => request<EmbeddedGodStatus>('/api/godclaude/install', { method: 'POST' }),

  godArm: (on: boolean) =>
    request<EmbeddedGodAction>('/api/godclaude/arm', {
      method: 'POST',
      body: JSON.stringify({ on }),
    }),

  // Per-session god toggle (terminal toolbar): overlay for ONE Claude session.
  godArmSession: (sessionId: string, on: boolean) =>
    request<{ output: string; active: boolean }>('/api/godclaude/arm', {
      method: 'POST',
      body: JSON.stringify({ on, sessionId }),
    }),

  godSessionState: (sessionId: string) =>
    request<{ installed: boolean; active: boolean; modes: string[] }>(
      `/api/godclaude/sessions/${encodeURIComponent(sessionId)}/state`,
    ),

  godMode: (mode: string, sessionId?: string) =>
    request<EmbeddedGodAction>('/api/godclaude/mode', {
      method: 'POST',
      body: JSON.stringify({ mode, sessionId }),
    }),

  godAutopilot: (on: boolean) =>
    request<EmbeddedGodAction>('/api/godclaude/autopilot', {
      method: 'POST',
      body: JSON.stringify({ on }),
    }),

  // --- Code Map (project codebase graph via codebase-memory-mcp) ---
  getCodeEngine: () => request<CodeEngineStatus>('/api/code-graph/engine'),

  generateCodeGraph: (projectId: string, scope: CodeScope) =>
    request<{ graph: CodeGraph; engine: CodeEngineStatus }>(
      `/api/projects/${projectId}/code-graph/generate`,
      { method: 'POST', body: JSON.stringify({ scope }) },
    ),

  getCodeGraph: (projectId: string, scope: CodeScope) =>
    request<{ graph: CodeGraph }>(
      `/api/projects/${projectId}/code-graph?scope=${encodeURIComponent(scope)}`,
    ),

  getCodeChanges: (projectId: string) =>
    request<CodeChanges>(`/api/projects/${projectId}/code-graph/changes`),

  // Everything the engine stores about one clicked node — backs the inspector
  // section rendered under the graph.
  getCodeNodeDetail: (projectId: string, nodeId: string) =>
    request<{ detail: CodeNodeDetail }>(
      `/api/projects/${projectId}/code-graph/node?nodeId=${encodeURIComponent(nodeId)}`,
    ),

  // Toggle whether this project's Code Map is embedded (as an MCP server) into
  // the Claude sessions NARUKAMI launches for it.
  setCodeMapEmbed: (projectId: string, enabled: boolean) =>
    request<{ codeMapEmbed: boolean }>(`/api/projects/${projectId}/code-graph/embed`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  // --- Armory (read-only inventory of skills / hooks / memory / agents / commands) ---
  getArmory: () => request<Armory>('/api/armory'),
};

// ── mobile share side (phone) ────────────────────────────────────────────────
// The phone loads a TOKENLESS page over the LAN relay, so it must derive its
// origin from window.location — NOT from SAME_ORIGIN (which is gated on the
// master-token injection that a phone never receives). Its credential is the
// per-terminal share token from the QR's `?m=` param.

function mobileOrigin(): string {
  return typeof window !== 'undefined' ? window.location.origin : API_BASE;
}

/**
 * This phone's stable self-identity for the device Allow/Deny gate. Random,
 * minted once, kept in localStorage so approval survives reloads/reconnects
 * (but a different phone — different localStorage — must knock for itself).
 */
function randomDeviceId(): string {
  // crypto.randomUUID is SECURE-CONTEXT-only and the phone page is plain HTTP
  // over the LAN relay — build the id from getRandomValues (always available).
  // (TS's lib types declare randomUUID unconditionally, hence the widening.)
  const c = crypto as Crypto & { randomUUID?: () => string };
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function mobileDeviceId(): string {
  const KEY = 'narukami-device-id';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = randomDeviceId();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    // Storage unavailable (private mode edge cases) — a per-load id still works,
    // it just re-prompts the desktop after a full reload.
    return randomDeviceId();
  }
}

/** WS URL for a shared terminal, authenticated with the share token (not master). */
export function mobileWsUrl(runId: string, shareToken: string): string {
  const wsBase = mobileOrigin().replace(/^http/, 'ws');
  return `${wsBase}/ws/runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(shareToken)}&device=${encodeURIComponent(mobileDeviceId())}`;
}

/** Share-scoped run metadata + liveness (drives the mobile reconnect loop). */
export async function getMobileRun(runId: string, shareToken: string): Promise<MobileRunInfo> {
  const url = `${mobileOrigin()}/api/mobile/run?run=${encodeURIComponent(runId)}&m=${encodeURIComponent(shareToken)}&device=${encodeURIComponent(mobileDeviceId())}`;
  const res = await fetch(url);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    throw new Error((body as ErrorBody | undefined)?.error ?? `Request failed (${res.status})`);
  }
  return body as MobileRunInfo;
}

/**
 * Download a release zip through the browser. A plain <a href> can't carry the
 * Authorization header, so fetch → blob → synthetic anchor click.
 */
export async function downloadReleaseZip(releaseId: string, filename: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/releases/${releaseId}/zip`, {
    headers: { Authorization: `Bearer ${TOKEN ?? ''}` },
  });
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const body = (await res.json()) as ErrorBody;
      if (body.error) message = body.error;
    } catch {
      // keep the status message
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
