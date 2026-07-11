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
  codeMapEmbed?: boolean; // Code Map (codebase-memory-mcp) attached to this project's Claude sessions
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

// --- editor git integration (mirror packages/backend/src/services/gitEditor.ts) ---
export interface GitBranch {
  branch: string | null; // branch name, or short SHA when detached; null if not a git repo
  detached: boolean;
}
export interface FileHead {
  path: string;
  committed: boolean; // false = new/untracked (diff against empty)
  content: string; // committed (HEAD) content
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
  view?: 'runner' | 'editor' | 'eod' | 'argus' | 'codemap' | 'armory';
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

// ── Argus Panoptes (god-monitor) ─────────────────────────────────────────────
// Read-only projection over the GODCLAUDE hook layer under ~/.claude. Shapes
// mirror packages/backend/src/services/argus.ts. Fields the god layer may omit
// are optional; the UI renders defensively.

export interface ArgusSession {
  pid: number | null;
  sessionId: string;
  cwd: string;
  name: string;
  version: string;
  status: string; // 'busy' | 'idle' (session self-report)
  modes: string[];
  state: 'live' | 'idle' | 'recent';
  ageMs: number;
  updatedAt: number | null;
  origin?: 'narukami' | 'native'; // launched by this NARUKAMI instance vs a native `claude` CLI
}

export interface ArgusSessions {
  count: number;
  live: number;
  items: ArgusSession[];
}

export interface ArgusHealth {
  armed?: boolean;
  requested?: string;
  effective?: string;
  effectiveModes?: string[];
  drift?: boolean;
  ok?: boolean;
  issues?: string[];
  modeCheck?: { mode?: string; gateValid?: boolean; gateKeys?: number; ok?: boolean; issues?: string[] };
}

export interface ArgusModeIntegrity {
  mode: string;
  files?: Record<string, boolean>;
  gateValid?: boolean;
  gateKeys?: number;
  ok?: boolean;
  issues?: string[];
}

export interface ArgusHeartbeat {
  ts: string;
  event: string;
  requested?: string;
  effective?: string;
  drift?: boolean;
  ok?: boolean;
  sensing?: boolean;
  issues?: string[];
}

export interface ArgusRouting {
  session?: string;
  effectiveModes?: string[];
  autopilot?: boolean;
}

export interface HookStat {
  hook: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
  totalMs: number;
  emitted: number;
  blocked: number;
}

export interface GateStats {
  allow: number;
  block: number;
  blockRate: number;
  settled: number;
  unsettled: number;
  allowReasons?: Record<string, number>;
  diagEvents?: Record<string, number>;
}

export interface GodStats {
  perfSpan: { from: string; to: string } | null;
  dispatch: Record<string, number>;
  hookStats: HookStat[];
  gate: GateStats;
  suggestions: string[];
}

export interface Usage {
  ts: number;
  model?: string;
  session_id?: string;
  rate_limits?: Record<string, { used_percentage?: number; resets_at?: number }>;
}

export interface ArgusStatus {
  ok: boolean;
  ts: string;
  godclaudeDetected: boolean;
  health: ArgusHealth | null;
  modes: ArgusModeIntegrity[];
  activity: Record<string, { allow: number; block: number }>;
  heartbeats: ArgusHeartbeat[];
  routing: ArgusRouting | null;
  stats: GodStats | null;
  sessions: ArgusSessions;
  usage: Usage | null;
}

/** NARUKAMI's own embedded godclaude instance (separate from the native ~/.claude). */
export interface EmbeddedGodStatus {
  ok: boolean;
  ts: string;
  home: string;
  installed: boolean;
  installedVersion: string | null;
  vendoredVersion: string | null;
  armed: boolean;
  autopilot: boolean;
  /** canonical mode folder names, e.g. ['developer'] — empty = general */
  modes: string[];
  nativeWiring: { settingsWired: boolean; hooksPresent: boolean };
  health: ArgusHealth | null;
  monitorModes: ArgusModeIntegrity[];
  activity: Record<string, { allow: number; block: number }>;
  heartbeats: ArgusHeartbeat[];
  routing: ArgusRouting | null;
  /** perf/gate aggregates of the embedded home */
  stats: GodStats | null;
  /** NARUKAMI-launched sessions only; modes from the embedded overlay */
  sessions: ArgusSessions;
  /** account-wide rate limits (instance-neutral) */
  usage: Usage | null;
}

export interface EmbeddedGodAction {
  output: string;
  status: EmbeddedGodStatus;
}

/** Header Instrument Cluster feed (GET /api/vitals) — whole-machine vitals. */
export interface VitalsSample {
  ts: number;
  cpu: number;
  memMB: number;
}

export interface VitalsFeed {
  history: VitalsSample[];
  machine: { totalMemMB: number; cores: number };
  usage: Usage | null;
}

export interface GraphNode {
  id: string;
  kind: 'memory' | 'project' | 'session' | 'ghost';
  label: string;
  type?: string;
  description?: string;
  project?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: 'in-project' | 'origin-session' | 'links-to';
  fuzzy?: boolean;
}

export interface MemoryGraph {
  ok: boolean;
  ts: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: { memory: number; projects: number; sessions: number; ghosts: number };
}

export interface MemoryNoteDetail {
  ok: boolean;
  project: string;
  slug: string;
  name: string;
  description: string;
  type: string;
  body: string;
  outlinks: string[];
  backlinks: string[];
}

export interface ArgusLogResult {
  source: string;
  file: string;
  exists: boolean;
  count: number;
  lines: unknown[];
}

// ── Code Map (project codebase graph via codebase-memory-mcp) ─────────────────
export type CodeScope = 'files' | 'functions' | 'architecture';

export interface CodeGraphNode {
  id: string;
  kind: string;
  label: string;
  file?: string;
}
export interface CodeGraphEdge {
  source: string;
  target: string;
  kind: string;
}
export interface CodeGraph {
  ok: boolean;
  scope: CodeScope;
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  counts: Record<string, number>;
  truncated: boolean;
}
export interface CodeNodeNeighbor {
  /** edge type, e.g. CALLS / DEFINES / IMPORTS */
  rel: string;
  dir: 'out' | 'in';
  id: string;
  label: string;
}
export interface CodeNodeDetail {
  id: string;
  kinds: string[];
  name: string | null;
  file: string | null;
  /** everything the engine stores on the node: signature, lines, complexity, flags… */
  props: Record<string, unknown>;
  neighbors: CodeNodeNeighbor[];
}
export interface CodeEngineStatus {
  installed: boolean;
  version: string | null;
}
export interface CodeChanges {
  changed: string[];
  ongoing: string[];
}

// --- EOD reports (mirror packages/backend/src/services/eodActivity.ts + routes/eod.ts) ---
export interface EodActiveProject {
  name: string;
  path: string;
  registered: boolean;
  projectId: string | null;
  sessions: number; // Claude sessions active that day (native + NARUKAMI)
  runs: number;
  commits: number;
}
export interface EodActiveResponse {
  day: string;
  projects: EodActiveProject[];
}
export interface EodReportDoc {
  id: string;
  day: string;
  markdown: string;
  projects: Array<{ name: string; path: string }>;
  createdAt: string;
  updatedAt: string;
}

// --- Armory (mirror packages/backend/src/services/armory.ts) ---
export type ArmoryScope = 'global' | 'project';
export interface ArmorySkill {
  name: string;
  description: string;
  scope: ArmoryScope;
  project?: string;
}
export interface ArmoryHook {
  event: string;
  matcher: string;
  command: string;
  scope: ArmoryScope;
  project?: string;
}
export interface ArmoryMemory {
  name: string;
  description: string;
  type: string;
  project: string;
}
export interface ArmoryDoc {
  name: string;
  description: string;
  scope: ArmoryScope;
  project?: string;
}
export interface Armory {
  ok: boolean;
  ts: string;
  skills: ArmorySkill[];
  hooks: ArmoryHook[];
  memory: ArmoryMemory[];
  agents: ArmoryDoc[];
  commands: ArmoryDoc[];
  counts: { skills: number; hooks: number; memory: number; agents: number; commands: number };
}
