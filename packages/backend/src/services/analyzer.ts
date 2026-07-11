import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { AnalyzerCommand, AnalyzerResult } from '../types';

const execFileAsync = promisify(execFile);

// The /eod skill keeps a per-project history for cross-day continuity, under
// ~/.claude/eod-history/<slug>/<day>.md. That path is inside Claude Code's own
// config dir, which it sandboxes tools out of even with --add-dir, so a headless
// run can't read or write it. NARUKAMI does that file I/O itself in Node instead
// (see readPriorEods / saveEodHistory) and hands the prior EODs to the skill as
// context — keeping the skill's continuity logic while dodging the sandbox.
const EOD_HISTORY_DIR = join(homedir(), '.claude', 'eod-history');
const EOD_HISTORY_KEEP = 3;

// 32 MiB is plenty for a JSON analysis; guards against a runaway response.
const MAX_BUFFER = 32 * 1024 * 1024;

// Hard ceiling on a single `claude -p` call. Without this, a blocking hook or a
// permission/trust gate in the target project's .claude/settings (which can't be
// answered in headless mode) leaves the child alive forever — the request hangs
// and, for analyze, the per-project lock is never released. Timing out kills the
// child (SIGKILL) and surfaces a clear error instead of a permanent hang.
const CLAUDE_TIMEOUT_MS = 120_000;

// The /eod skill does real work headlessly (git log, GitHub PR search, reading
// prior EODs, writing its history file), so it needs a longer ceiling than the
// pure text/JSON analyzers above.
const EOD_SKILL_TIMEOUT_MS = 300_000;

// Tools the /eod skill needs to gather its data (git/gh via Bash, Read/Glob/Grep
// for docs and files). Passed as an allowlist under `--permission-mode dontAsk`,
// so exactly these run and every other tool is auto-denied (no interactive
// approval is possible headless). Deliberately NOT `bypassPermissions` — the EOD
// button must not silently grant a headless agent unrestricted tool access. No
// Write: NARUKAMI persists the history file itself (see saveEodHistory).
const EOD_ALLOWED_TOOLS = 'Bash Read Glob Grep';

// Run the /eod skill with the user's hooks disabled. A heavily-hooked global
// config (e.g. a SessionStart/Stop "operating contract" that injects instructions)
// otherwise overrides the skill's "output ONLY the EOD text" with meta-commentary
// that lands in `.result` instead of the report. `disableAllHooks` skips hooks for
// THIS headless call only; the user command (~/.claude/commands/eod.md) still
// resolves (it is discovered from the filesystem, not via a hook).
const EOD_SETTINGS_OVERRIDE = JSON.stringify({ disableAllHooks: true });

const ANALYZE_PROMPT = `You are analyzing the software project in the current working directory to determine how to install and run it.

Inspect the files (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, Makefile, README, Dockerfile, etc.) and respond with ONLY a single minified JSON object and nothing else — no prose, no explanation, no markdown code fences.

The JSON must match exactly this shape:
{
  "type": "node|python|go|rust|other",
  "packageManager": "npm|pnpm|yarn|pip|poetry|cargo|go|unknown",
  "installCommand": "string or null",
  "commands": [
    { "label": "dev", "command": "npm run dev", "isDefault": true },
    { "label": "build", "command": "npm run build", "isDefault": false }
  ],
  "envVarsNeeded": ["DATABASE_URL"],
  "warnings": ["no obvious start script found"]
}

Rules:
- "commands" lists concrete shell commands a developer would run (dev server, build, test, start). Prefer the project's own declared scripts.
- Exactly one command must have "isDefault": true — the primary way to run/develop the project. If none is obvious, pick the most likely one.
- Use null (not the string "null") for installCommand when there is nothing to install.
- Keep arrays empty ([]) rather than omitting them.
- Output the JSON object only.`;

/** Thrown when Claude Code is missing, fails, or returns unusable output. */
export class AnalyzerError extends Error {
  public readonly raw?: string;

  constructor(message: string, raw?: string) {
    super(message);
    this.name = 'AnalyzerError';
    this.raw = raw;
  }
}

interface ExecError extends NodeJS.ErrnoException {
  stdout?: string;
  stderr?: string;
  /** Set by execFile when the child was killed — e.g. by the `timeout` option. */
  killed?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Strip a single ```json ... ``` (or ``` ... ```) fence if present. */
export function stripFences(text: string): string {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return fenced ? fenced[1].trim() : t;
}

/** Scan a balanced top-level `{ ... }` starting at `from` (which must be a `{`).
 * String-aware so braces inside string literals don't affect depth. Returns the
 * end index (exclusive) of the matching `}`, or -1 if it never closes. */
function scanBalancedObject(t: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < t.length; i += 1) {
    const ch = t[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Extract the first complete top-level { ... } object that actually parses as
 * JSON, tolerating surrounding prose — including prose that itself contains
 * braces. Each candidate brace group is JSON.parse-checked; a non-JSON group
 * like `{build, test}` (or noise injected by a hook) is skipped and scanning
 * continues to the next `{`. This matters in headless runs where SessionStart /
 * UserPromptSubmit hooks can prepend brace-bearing text before the real answer.
 */
export function extractJsonObject(text: string): string {
  const t = stripFences(text);
  let firstBalanced: string | null = null;

  let start = t.indexOf('{');
  if (start === -1) return t;

  while (start !== -1) {
    const end = scanBalancedObject(t, start);
    if (end === -1) break; // never closes — nothing more to try
    const candidate = t.slice(start, end);
    if (firstBalanced === null) firstBalanced = candidate;
    try {
      JSON.parse(candidate);
      return candidate; // first candidate that is real JSON wins
    } catch {
      // not JSON (e.g. `{build, test}`) — advance past it and keep looking
    }
    start = t.indexOf('{', end);
  }

  // No candidate parsed. Prefer the first balanced group (so a downstream
  // JSON.parse reports a precise error); otherwise hand back from the first brace.
  return firstBalanced ?? t.slice(t.indexOf('{'));
}

export function toCommand(value: unknown): AnalyzerCommand | null {
  if (!isRecord(value)) return null;
  const command = value.command;
  if (typeof command !== 'string' || !command.trim()) return null;
  const label = typeof value.label === 'string' && value.label.trim() ? value.label : 'run';
  return { label, command, isDefault: Boolean(value.isDefault) };
}

export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function normalize(parsed: unknown): AnalyzerResult {
  const obj = isRecord(parsed) ? parsed : {};

  const commands = Array.isArray(obj.commands)
    ? obj.commands.map(toCommand).filter((c): c is AnalyzerCommand => c !== null)
    : [];

  if (commands.length && !commands.some((c) => c.isDefault)) {
    commands[0].isDefault = true;
  }

  const installCommand =
    typeof obj.installCommand === 'string' && obj.installCommand.trim()
      ? obj.installCommand
      : null;

  return {
    type: typeof obj.type === 'string' && obj.type.trim() ? obj.type : 'other',
    packageManager:
      typeof obj.packageManager === 'string' && obj.packageManager.trim()
        ? obj.packageManager
        : 'unknown',
    installCommand,
    commands,
    envVarsNeeded: toStringArray(obj.envVarsNeeded),
    warnings: toStringArray(obj.warnings),
  };
}

async function runClaude(
  prompt: string,
  cwd: string,
  opts: { extraArgs?: string[]; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? CLAUDE_TIMEOUT_MS;
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', prompt, '--output-format', 'json', ...(opts.extraArgs ?? [])],
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      },
    );
    return stdout;
  } catch (err) {
    const e = err as ExecError;
    if (e.code === 'ENOENT') {
      throw new AnalyzerError(
        'The `claude` CLI was not found on your PATH. Install Claude Code and run `claude login`, then retry.',
      );
    }
    // execFile marks a timed-out child with `killed` (SIGKILL from the timeout).
    // Most likely a hook or a permission/trust gate in the project stalled the
    // headless run — say so, since it can't be answered from here.
    if (e.killed) {
      throw new AnalyzerError(
        `claude -p timed out after ${timeoutMs / 1000}s and was killed. A hook or a ` +
          `permission/folder-trust gate in this project likely blocked the headless run — ` +
          `open the folder in Claude Code once to trust it, or loosen the blocking hook, then retry.`,
        e.stdout || e.stderr || '',
      );
    }
    throw new AnalyzerError(`claude -p failed: ${e.message}`, e.stdout || e.stderr || '');
  }
}

/** Parse the `--output-format json` envelope and return the model's answer text. */
export function unwrapEnvelope(stdout: string): string {
  let outer: unknown;
  try {
    outer = JSON.parse(stdout);
  } catch {
    // Not JSON at all — hand back the raw text for downstream parsing/errors.
    return stdout;
  }
  if (isRecord(outer) && typeof outer.result === 'string') return outer.result;
  return stdout;
}

export interface RawAnalysis {
  parsed: AnalyzerResult;
  /** The full outer JSON object returned by `claude -p`, stored for auditing. */
  raw: unknown;
}

export async function analyzeProject(projectPath: string): Promise<RawAnalysis> {
  const stdout = await runClaude(ANALYZE_PROMPT, projectPath);

  let outer: unknown = stdout;
  try {
    outer = JSON.parse(stdout);
  } catch {
    // keep the raw string as `raw` if the envelope wasn't JSON
  }

  const inner = unwrapEnvelope(stdout);
  const jsonText = extractJsonObject(inner);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new AnalyzerError(
      'Could not parse the analysis JSON returned by Claude Code.',
      inner,
    );
  }

  return { parsed: normalize(parsed), raw: outer };
}

/** Ask Claude Code to turn a natural-language request into a runnable command. */
export async function suggestCommand(
  projectPath: string,
  request: string,
): Promise<{ label: string; command: string }> {
  const prompt = `In the project in the current working directory, the developer wants to: "${request}".

Determine the single shell command that accomplishes this for THIS project. Inspect the project's files (package.json, pyproject.toml, Makefile, Cargo.toml, etc.) and prefer its real declared scripts/tooling.

Respond with ONLY a single minified JSON object and nothing else — no prose, no markdown fences:
{ "label": "short-label", "command": "the exact shell command" }

- "label" is 1-3 words (e.g. "test:watch", "lint", "start:prod").
- "command" runs from the project root.
- Output the JSON object only.`;

  const stdout = await runClaude(prompt, projectPath);
  const inner = unwrapEnvelope(stdout);
  const jsonText = extractJsonObject(inner);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new AnalyzerError('Could not parse the command suggestion from Claude Code.', inner);
  }

  const obj = isRecord(parsed) ? parsed : {};
  const command = typeof obj.command === 'string' ? obj.command.trim() : '';
  if (!command) {
    throw new AnalyzerError('Claude Code did not return a runnable command.', inner);
  }
  const label = typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : 'custom';
  return { label, command };
}

/** Feed a failed run's output to Claude Code and return a plain-text explanation. */
export async function diagnoseRun(
  projectPath: string,
  command: string,
  output: string,
): Promise<string> {
  const prompt = `A command failed while running a local project.

Command: ${command}

Captured terminal output (may be truncated to the tail):
"""
${output.slice(-12000)}
"""

Explain briefly why it most likely failed and give concrete steps to fix it. Respond in plain text (no JSON, no code fences unless quoting a command).`;

  const stdout = await runClaude(prompt, projectPath);
  return unwrapEnvelope(stdout);
}

/** The skill's per-project history slug: basename of the git repo root at
 * `projectPath` (fallback: the directory basename). Matches the /eod command's
 * own `basename $(git rev-parse --show-toplevel || pwd)`. */
async function eodHistorySlug(projectPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectPath, 'rev-parse', '--show-toplevel'], {
      timeout: 10_000,
      windowsHide: true,
    });
    const root = stdout.trim();
    if (root) return basename(root);
  } catch {
    // not a git repo / git missing — fall through to the dir basename
  }
  return basename(projectPath);
}

/** The up-to-3 most recent prior EOD reports for a project (newest first),
 * excluding `day` itself. '' when there's no history yet. Best-effort. */
export async function readPriorEods(historyDir: string, day: string): Promise<string> {
  try {
    const files = (await readdir(historyDir))
      .filter((f) => f.endsWith('.md') && f !== `${day}.md`)
      .sort() // filenames are YYYY-MM-DD.md, so lexical sort == chronological
      .reverse()
      .slice(0, EOD_HISTORY_KEEP);
    const blocks: string[] = [];
    for (const f of files) {
      const text = (await readFile(join(historyDir, f), 'utf8')).trim();
      if (text) blocks.push(`----- ${f.replace(/\.md$/, '')} -----\n${text}`);
    }
    return blocks.join('\n\n');
  } catch {
    return '';
  }
}

/** Persist today's report (one file per day, overwrite) and prune to the newest
 * EOD_HISTORY_KEEP days. Done in Node because the headless skill is sandboxed out
 * of ~/.claude. Best-effort — a failed save never fails the request. */
export async function saveEodHistory(historyDir: string, day: string, report: string): Promise<void> {
  try {
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, `${day}.md`), report.endsWith('\n') ? report : `${report}\n`, 'utf8');
    const stale = (await readdir(historyDir))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(EOD_HISTORY_KEEP);
    for (const f of stale) await rm(join(historyDir, f), { force: true }).catch(() => {});
  } catch {
    // best-effort; the report is also stored in NARUKAMI's own DB
  }
}

/**
 * Generate the end-of-day report by invoking the user's OWN `/eod` skill
 * (~/.claude/commands/eod.md) headlessly in the project directory, rather than a
 * bespoke inline prompt. The skill does its own wide-net data gathering — merged
 * GitHub PRs, local branches, the day's git log — and emits the user's exact EOD
 * format and continuity logic.
 *
 * NARUKAMI supplies, as appended system context (kept separate from the
 * `/eod <day>` argument so the skill's date parsing stays clean):
 *   - the day's tracked runs (Claude sessions / commands NARUKAMI executed),
 *   - the developer's note for work NOT in commits and NOT in the tracked session
 *     (offline/manual work), and
 *   - the prior EODs for continuity (read from history in Node).
 * It then persists the returned report to history itself. The skill is told to
 * skip its own history read/write, since it is sandboxed out of ~/.claude.
 *
 * Runs with `--permission-mode dontAsk` + an explicit `--allowedTools` allowlist
 * (no Write) and a longer timeout. Intentionally not `bypassPermissions`.
 */
export async function runEodSkill(args: {
  projectPath: string;
  projectName: string;
  day: string;
  runsText: string;
  note: string;
}): Promise<string> {
  const { projectPath, projectName, day, runsText, note } = args;

  const historyDir = join(EOD_HISTORY_DIR, await eodHistorySlug(projectPath));
  const priorEods = await readPriorEods(historyDir, day);

  // Appended to the system prompt. execFile passes this as one argv element (no
  // shell), so the note / run / prior-EOD text can't break out or inject flags.
  const context = [
    `This /eod run was triggered by NARUKAMI (a local project runner) for the project "${projectName}" at ${projectPath}, for ${day}. Treat ${day} as the target date regardless of any other text in the command arguments.`,
    '',
    'NARUKAMI handles history for you: it has already read the prior EODs (below) and will save this report to ~/.claude/eod-history itself. Do NOT try to read or write that directory — you are sandboxed out of it. Do all your OTHER data gathering (git log, GitHub PRs, branches, docs) as normal, and output ONLY the final EOD text.',
    '',
    'NARUKAMI recorded activity that git history alone does not show. Fold the relevant parts into the report, following the EXACT style and format the /eod command specifies — do not add sections or commentary it does not ask for.',
    '',
    'Tracked runs today — the Claude sessions, commands, and shells NARUKAMI executed in this project (label · kind · status · duration). This is "the Claude session" side of the work:',
    '"""',
    runsText.trim() ? runsText.slice(-6000) : '(no tracked runs recorded)',
    '"""',
    '',
    "Developer's note — work done today that is NOT in git commits and NOT in the tracked runs above (offline/manual work: meetings, decisions, reviews, ops). Treat it as first-hand truth and include it in the report:",
    '"""',
    note.trim() ? note.slice(0, 2000) : '(no note provided)',
    '"""',
    '',
    priorEods
      ? `Prior EODs for this project, most recent first — use them for continuity exactly as the command says (never re-list a feature already covered; report only today's deltas as follow-ups):\n"""\n${priorEods.slice(-8000)}\n"""`
      : 'No prior EODs recorded for this project yet — this is the first tracked day, so no continuity dedupe is needed.',
  ].join('\n');

  const stdout = await runClaude(`/eod ${day}`, projectPath, {
    extraArgs: [
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      EOD_ALLOWED_TOOLS,
      '--settings',
      EOD_SETTINGS_OVERRIDE,
      '--append-system-prompt',
      context,
    ],
    timeoutMs: EOD_SKILL_TIMEOUT_MS,
  });

  const report = unwrapEnvelope(stdout).trim();
  if (report) await saveEodHistory(historyDir, day, report);
  return report;
}
