// Live "what is this process doing right now" store. Every terminal feeds its
// output chunks here (feedRunOutput); the Dashboard's live-process cards
// subscribe and render a real-time, human-readable action ("Editing App.tsx",
// "Running npm run build", "Thinking…") plus a short output tail.
//
// A dependency-free module singleton — same shape as activityBus — so there's no
// prop-drilling the terminal stream through the component tree. The parse is
// heuristic (terminal output is unstructured) and intentionally forgiving: it
// degrades to showing the latest output line rather than ever throwing.

export type ActionKind = 'edit' | 'write' | 'read' | 'run' | 'search' | 'think' | 'output';

export interface RunAction {
  kind: ActionKind;
  verb: string; // 'Editing', 'Running', 'Thinking'…
  target: string; // file path / command / '' — already truncated for display
}

export interface TouchedFile {
  path: string;
  kind: ActionKind; // last operation on it (edit/write/read)
}

export interface RunActivity {
  runId: string;
  action: RunAction | null; // what it's doing right now
  actions: RunAction[]; // recent distinct actions, most recent last (a trail)
  files: TouchedFile[]; // files touched this task, most recent last
  tail: string[]; // last few cleaned output lines (most recent last)
  lines: number; // total non-empty output lines this task
  bytes: number; // cumulative output bytes this task
  startedTs: number; // start of the current working burst (ms)
  lastTs: number; // ms of the last output chunk
}

type Listener = (runId: string) => void;

const listeners = new Set<Listener>();
const store = new Map<string, RunActivity>();
// Rolling decoded-text buffer per run (bounded) that the parser reads from.
const buffers = new Map<string, string>();
// A trailing partial ANSI escape held back until the next chunk completes it —
// WebSocket chunks split at arbitrary byte offsets, so a sequence can straddle
// two feedRunOutput calls.
const carry = new Map<string, string>();

const BUF_MAX = 8000; // chars of scrollback kept per run for parsing
const TAIL_LINES = 8; // output lines surfaced on the card
const SCAN_LINES = 40; // how far back the action parser looks
const STALE_RESET_MS = 6000; // gap after which a run's next output starts a fresh buffer
const CARRY_MAX = 128; // never hold back more than this as a "partial escape"
const ACTIONS_MAX = 6; // length of the recent-action trail
const FILES_MAX = 8; // files-touched chips kept per task
const FILE_KINDS = new Set<ActionKind>(['edit', 'write', 'read']);

function isPathLike(s: string): boolean {
  return /[\\/]/.test(s) || /\.[A-Za-z0-9]{1,6}$/.test(s);
}

function emit(runId: string): void {
  for (const l of listeners) {
    try {
      l(runId);
    } catch {
      /* a throwing subscriber must not stall the others */
    }
  }
}

/** Strip ANSI/VT control sequences and non-printable control chars (keep \t). */
export function stripAnsi(input: string): string {
  return (
    input
      // OSC: ESC ] … BEL  or  ESC ] … ST(ESC \). Bounded to a single line so an
      // unterminated introducer can't swallow real multi-line output.
      .replace(/\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)/g, '')
      // CSI: ESC [ … final-byte
      .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '')
      // other two-char escapes: ESC <single>
      .replace(/\x1b[@-Z\\-_]/g, '')
      // stray control chars except tab/newline/carriage-return
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  );
}

// Split off a trailing INCOMPLETE escape sequence (lone ESC, or CSI/OSC with no
// final byte / terminator yet) so it can be carried to the next chunk. A
// complete sequence never matches (its final byte fails the anchored pattern).
function splitDanglingEscape(s: string): { text: string; pending: string } {
  const m = /\x1b(?:\[[0-9;:?]*[ -/]*|\][^\x07\x1b\n]*)?$/.exec(s);
  if (m && m.index >= 0 && s.length - m.index <= CARRY_MAX) {
    return { text: s.slice(0, m.index), pending: s.slice(m.index) };
  }
  return { text: s, pending: '' };
}

const SPINNER_RE = /[⠀-⣿⠁⠋⠙⠹⠸⠼⠴⠦⠇⠏]/; // braille spinners
const THINK_RE = /(esc to interrupt|\bthinking\b|\bpondering\b|\bworking…|\bcerebrating\b|✻|✽|✶|✳|◐|◓|◑|◒)/i;

// Claude Code tool-call markers, e.g. "● Edit(src/App.tsx)" / "⏺ Bash(npm i)".
const TOOL_RE =
  /^[\s>|·⏺●∘◦*+\-–—]*\b(MultiEdit|NotebookEdit|Edit|Update|Write|Create|Read|Bash|Grep|Glob|Search|Task|WebFetch|WebSearch|Move|Rename|Delete)\b\s*\(([^]*?)\)?\s*$/i;

const TOOL_MAP: Record<string, { verb: string; kind: ActionKind }> = {
  edit: { verb: 'Editing', kind: 'edit' },
  multiedit: { verb: 'Editing', kind: 'edit' },
  update: { verb: 'Editing', kind: 'edit' },
  notebookedit: { verb: 'Editing', kind: 'edit' },
  write: { verb: 'Writing', kind: 'write' },
  create: { verb: 'Writing', kind: 'write' },
  read: { verb: 'Reading', kind: 'read' },
  bash: { verb: 'Running', kind: 'run' },
  grep: { verb: 'Searching', kind: 'search' },
  glob: { verb: 'Searching', kind: 'search' },
  search: { verb: 'Searching', kind: 'search' },
  task: { verb: 'Delegating', kind: 'run' },
  webfetch: { verb: 'Browsing', kind: 'search' },
  websearch: { verb: 'Browsing', kind: 'search' },
  move: { verb: 'Moving', kind: 'write' },
  rename: { verb: 'Moving', kind: 'write' },
  delete: { verb: 'Deleting', kind: 'write' },
};

// Shell prompt line: "PS C:\x> cmd", "$ cmd", "/path$ cmd", "~/x# cmd".
// A non-empty path prefix (or a bare "$") is required before the sigil so a
// markdown heading ("# Title") or quote ("> text") isn't read as a command.
const PROMPT_RE = /^(?:PS\s+[^\n>]*>|[\w.:/~\\-]+\s*[$#>]|\$)\s+(\S.*)$/;
// A line that itself starts with a well-known dev command.
const CMD_RE =
  /^(npm|pnpm|yarn|bun|node|npx|deno|tsc|vite|eslint|prettier|jest|vitest|git|python|python3|pip|pytest|cargo|rustc|go|docker|kubectl|make|gradle|mvn|dotnet|php|composer|ruby|rails|bundle)\b/i;

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Clean a tool-call argument blob into a concise target string. */
const TOOL_LABEL_RE =
  /^(?:file_path|filepath|path|command|cmd|pattern|query|url|prompt|notebook_path|old_string|new_string|content|description|glob|subagent_type)\s*[:=]\s*/i;

function cleanToolArg(raw: string): string {
  let s = raw.trim();
  // drop a leading KNOWN "name:" label. Only a whitelist, so a Windows drive
  // path like C:\Users\… isn't mistaken for a "C:" label and truncated.
  s = s.replace(TOOL_LABEL_RE, '');
  // unwrap surrounding quotes
  s = s.replace(/^["'`]/, '').replace(/["'`]$/, '');
  // collapse to the first line / first arg
  s = s.split(/\n/)[0];
  const comma = s.indexOf(', ');
  if (comma > 0 && !s.includes('/') && !s.includes('\\')) s = s.slice(0, comma);
  return clip(s, 72);
}

/** Parse the most recent meaningful action from a set of cleaned lines. */
export function parseAction(lines: string[]): RunAction | null {
  const recent = lines.slice(-SCAN_LINES);
  for (let i = recent.length - 1; i >= 0; i--) {
    const line = recent[i];
    if (!line) continue;

    const tool = TOOL_RE.exec(line);
    if (tool) {
      const name = tool[1].toLowerCase();
      const map = TOOL_MAP[name] ?? { verb: tool[1], kind: 'run' as ActionKind };
      return { kind: map.kind, verb: map.verb, target: cleanToolArg(tool[2] ?? '') };
    }

    const prompt = PROMPT_RE.exec(line);
    if (prompt) return { kind: 'run', verb: 'Running', target: clip(prompt[1], 72) };

    if (CMD_RE.test(line.trim())) return { kind: 'run', verb: 'Running', target: clip(line, 72) };
  }

  // No structured action — is it clearly "thinking", or just streaming output?
  for (let i = recent.length - 1; i >= Math.max(0, recent.length - 6); i--) {
    const line = recent[i];
    if (line && THINK_RE.test(line)) return { kind: 'think', verb: 'Thinking', target: '' };
  }

  // Fallback: surface the latest non-spinner line as generic output.
  for (let i = recent.length - 1; i >= 0; i--) {
    const line = recent[i];
    if (line && !SPINNER_RE.test(line)) return { kind: 'output', verb: 'Working', target: clip(line, 80) };
  }
  return null;
}

function toLines(buf: string): string[] {
  const out: string[] = [];
  let prev = '';
  for (const rawLine of buf.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (line === prev) continue; // collapse repeated spinner frames
    out.push(clip(line, 200));
    prev = line;
  }
  return out;
}

/** Feed a raw terminal output chunk for a run. Safe to call very frequently. */
export function feedRunOutput(runId: string, chunk: string): void {
  if (!chunk) return;
  const prev = store.get(runId);
  // A long quiet gap means a new task started — drop the previous task's
  // scrollback so a reappearing card doesn't flash the old action/tail.
  const stale = prev ? Date.now() - prev.lastTs > STALE_RESET_MS : false;

  // Re-join any carried partial escape, then hold back a new trailing partial.
  const { text, pending } = splitDanglingEscape((stale ? '' : carry.get(runId) ?? '') + chunk);
  carry.set(runId, pending);

  const cleaned = stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n'); // treat progress rewrites as line breaks
  let buf = (stale ? '' : buffers.get(runId) ?? '') + cleaned;
  if (buf.length > BUF_MAX) buf = buf.slice(-BUF_MAX);
  buffers.set(runId, buf);

  const now = Date.now();
  const lines = toLines(buf);
  const action = parseAction(lines);

  // Recent-action trail: append the current action when it's a meaningful,
  // non-repeat transition (skip the generic "output" fallback).
  let actions = stale ? [] : prev?.actions ?? [];
  if (action && action.kind !== 'output') {
    const last = actions[actions.length - 1];
    if (!last || last.kind !== action.kind || last.target !== action.target) {
      actions = [...actions, action].slice(-ACTIONS_MAX);
    }
  }

  // Files touched: dedupe by path, most-recent last.
  let files = stale ? [] : prev?.files ?? [];
  if (action && FILE_KINDS.has(action.kind) && action.target && isPathLike(action.target)) {
    files = files.filter((f) => f.path !== action.target);
    files = [...files, { path: action.target, kind: action.kind }].slice(-FILES_MAX);
  }

  const newLines = cleaned.split('\n').filter((l) => l.trim()).length;

  store.set(runId, {
    runId,
    action,
    actions,
    files,
    tail: lines.slice(-TAIL_LINES),
    lines: (stale ? 0 : prev?.lines ?? 0) + newLines,
    bytes: (stale ? 0 : prev?.bytes ?? 0) + chunk.length,
    startedTs: stale || !prev ? now : prev.startedTs,
    lastTs: now,
  });
  emit(runId);
}

export function getRunActivity(runId: string): RunActivity | undefined {
  return store.get(runId);
}

export function getRunActivityMap(): Map<string, RunActivity> {
  return store;
}

/** Drop a run's activity + buffer (on process exit or tab close). */
export function clearRunActivity(runId: string): void {
  const had = store.delete(runId);
  buffers.delete(runId);
  carry.delete(runId);
  if (had) emit(runId);
}

export function subscribeRunActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
