export interface RunCommand {
  id: string;
  projectId: string;
  label: string;
  command: string;
  cwd: string | null;
  isDefault: boolean;
  source: string; // "detected" | "custom"
  createdAt: string;
}

export interface RunSummary {
  id: string;
  status: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  type: string | null;
  packageMgr: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  commands: RunCommand[];
  runs: RunSummary[];
}

export interface AnalyzerResult {
  type: string;
  packageManager: string;
  installCommand: string | null;
  commands: { label: string; command: string; isDefault: boolean }[];
  envVarsNeeded: string[];
  warnings: string[];
}

export interface FileNode {
  name: string;
  path: string; // project-relative, POSIX separators
  type: 'dir' | 'file';
  children?: FileNode[];
}

export interface ProjectTree {
  root: string;
  tree: FileNode[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  mtimeMs: number; // file mtime at open; sent back on save for conflict detection
}

export type RunStatus = 'connecting' | 'running' | 'exited' | 'killed' | 'error';

export interface ActiveRun {
  runId: string;
  projectId: string;
  projectName: string;
  label: string; // command label, "shell", or "claude"
  customLabel?: string; // user-renamed tab name (persisted, overrides label)
  kind: 'command' | 'shell' | 'claude';
  status: RunStatus;
  exitCode: number | null;
  // Admin (elevated) shell — streamed via the broker. `pending` is true while the
  // UAC prompt is outstanding and the elevated agent hasn't connected back yet.
  elevated?: boolean;
  pending?: boolean;
}

// A notification shown as a clickable toast (routes to the tab).
// - 'exit': the process ended (exited/killed/error).
// - 'task': a long-lived process (Claude/shell) finished a task and went idle.
export interface Toast {
  id: string;
  runId: string;
  projectId: string;
  projectName: string;
  label: string;
  kind: 'command' | 'shell' | 'claude';
  status: RunStatus;
  exitCode: number | null;
  event: 'exit' | 'task';
}

// A terminal tab restored from the backend workspace (open tabs survive reopen).
export interface RestoredRun {
  runId: string;
  projectId: string;
  projectName: string;
  kind: 'command' | 'shell' | 'claude';
  name: string | null;
  label: string;
  live?: boolean;
  status?: string;
}

// One finished run captured in an End-of-Day snapshot.
export interface EodItem {
  label: string;
  kind: string;
  command: string | null; // actual shell command, for 'command' runs
  status: string;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

// A git commit landed on an EOD day (the day's "added features" list).
export interface EodCommit {
  hash: string;
  subject: string;
  body: string;
  filesChanged: number | null;
}

// A saved End-of-Day entry: what a project finished on one local day.
export interface EodEntry {
  id: string;
  projectId: string;
  day: string; // 'YYYY-MM-DD'
  items: EodItem[];
  commits: EodCommit[]; // features/changes committed that day (recomputed from git)
  note: string | null;
  summary: string | null; // AI-generated narrative (on demand)
  createdAt: string;
  updatedAt: string;
}

// Persisted UI layout (stored server-side under the 'ui' settings key).
export interface UiSettings {
  selectedId?: string | null;
  view?: 'runner' | 'editor' | 'eod';
  dockPosition?: 'bottom' | 'right';
  dockHeight?: number;
  dockWidth?: number;
  dockMinimized?: boolean;
  sidebarCollapsed?: boolean;
  activeTabByProject?: Record<string, string>;
  editorFileByProject?: Record<string, string>;
}

export interface WorkspaceState {
  runs: RestoredRun[];
  settings: { ui?: UiSettings } & Record<string, unknown>;
}
