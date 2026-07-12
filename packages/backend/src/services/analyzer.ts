import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AnalyzerCommand, AnalyzerResult } from '../types';

const execFileAsync = promisify(execFile);

// 32 MiB is plenty for a JSON analysis; guards against a runaway response.
const MAX_BUFFER = 32 * 1024 * 1024;

// Hard ceiling on a single `claude -p` call. Without this, a blocking hook or a
// permission/trust gate in the target project's .claude/settings (which can't be
// answered in headless mode) leaves the child alive forever — the request hangs
// and, for analyze, the per-project lock is never released. Timing out kills the
// child (SIGKILL) and surfaces a clear error instead of a permanent hang.
const CLAUDE_TIMEOUT_MS = 120_000;

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

export async function runClaude(prompt: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', prompt, '--output-format', 'json'],
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        timeout: CLAUDE_TIMEOUT_MS,
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
        `claude -p timed out after ${CLAUDE_TIMEOUT_MS / 1000}s and was killed. A hook or a ` +
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

/**
 * Write a concise end-of-day narrative for a project from the day's finished
 * runs (+ the user's note). Plain prose, first-person, a few sentences.
 */
export async function summarizeDay(
  projectPath: string,
  day: string,
  runsText: string,
  commitsText: string,
  note: string,
): Promise<string> {
  const prompt = `You are writing a short end-of-day work summary for a software project, for ${day}.

Features/changes committed to git today (subject + details per commit):
"""
${commitsText.slice(-9000) || '(no commits today)'}
"""

Runs that finished in the project today (label · kind · status · duration):
"""
${runsText.slice(-6000) || '(no finished runs recorded)'}
"""

${note ? `The developer's own note for the day:\n"""\n${note.slice(0, 2000)}\n"""\n` : ''}
Write a concise, factual end-of-day summary (2-5 sentences, plain text, no markdown, no bullet list). Lead with the features/changes that were added (from the commits); mention notable run failures if any. If there's very little signal, say so briefly. Do not invent specifics that aren't supported by the data.`;

  const stdout = await runClaude(prompt, projectPath);
  return unwrapEnvelope(stdout).trim();
}
