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

// Cross-browser accuracy advisor: where the embedded Chromium preview diverges
// from the real target browser (Safari/Firefox/…). 'catalog' findings come from
// the curated reference; 'claude' findings are specific to this project's code.
export interface AccuracyFinding {
  area: string;
  severity: 'high' | 'medium' | 'low';
  note: string;
  fix: string;
  source: 'catalog' | 'claude';
}

export interface AccuracyReport {
  engine: string;
  summary: string;
  findings: AccuracyFinding[];
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
}

// Working-tree state of a file relative to the last commit — added (green),
// modified (amber), or deleted (red). Drives the editor's change highlighting.
export type GitChange = 'added' | 'modified' | 'deleted';

export interface GitFileStatus {
  path: string; // project-relative, POSIX separators
  status: GitChange;
}

export interface GitStatus {
  isRepo: boolean;
  files: GitFileStatus[];
}

// A contiguous run of changed lines (1-based, inclusive) on the working-tree side.
export interface DiffRange {
  start: number;
  end: number;
  type: GitChange;
}

export interface GitDiff {
  isRepo: boolean;
  tracked: boolean; // false → untracked; the whole open file is treated as added
  ranges: DiffRange[];
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

// --- token-usage telemetry (Dashboard view), from the backend ---
export interface UsageTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  msgs: number;
  total: number;
}
export interface DayUsage {
  day: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  msgs: number;
  total: number;
}
export interface SessionUsage {
  id: string;
  label: string;
  day: string;
  msgs: number;
  dur: number;
  input: number;
  output: number;
  cw: number;
  cr: number;
  total: number;
}
export interface UsageReport {
  project: string;
  found: boolean;
  logDir: string;
  model: string;
  sessionsTotal: number;
  sessionsActive: number;
  rangeFirst: string | null;
  rangeLast: string | null;
  totals: UsageTotals;
  counts: { userMsgs: number; assistantMsgs: number; toolResults: number };
  byDay: DayUsage[];
  sessions: SessionUsage[];
}

// Account-wide rolling-window usage (for the "almost full" limit gauge).
export interface UsageWindow {
  tokens: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  msgs: number;
  earliestTs: number | null;
}
export interface HourBucket {
  hourStart: number;
  tokens: number;
  msgs: number;
}
// Anthropic's real subscription usage (from ~/.claude/usage-live.json — the same
// numbers claude.ai → Usage and /usage show).
export interface LiveWindow {
  usedPercentage: number;
  resetsAt: number | null;
}
export interface LiveUsage {
  available: boolean;
  ts: number | null;
  model: string | null;
  fiveHour: LiveWindow | null;
  sevenDay: LiveWindow | null;
  stale: boolean;
}
export interface UsageWindows {
  now: number;
  projects: number;
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  perHour: HourBucket[];
  live: LiveUsage;
}

// Persisted UI layout (stored server-side under the 'ui' settings key).
export interface UiSettings {
  selectedId?: string | null;
  view?: 'runner' | 'editor' | 'eod' | 'dashboard' | 'live' | 'browser' | 'blueprint';
  dockPosition?: 'bottom' | 'right';
  dockHeight?: number;
  dockWidth?: number;
  dockMinimized?: boolean;
  sidebarCollapsed?: boolean;
  activeTabByProject?: Record<string, string>;
  editorFileByProject?: Record<string, string>; // legacy: single last-open file per project
  editorTabsByProject?: Record<string, { open: string[]; active: string | null }>;
}

export interface WorkspaceState {
  runs: RestoredRun[];
  settings: { ui?: UiSettings } & Record<string, unknown>;
}
