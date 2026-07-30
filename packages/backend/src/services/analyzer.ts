import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AnalyzerCommand, AnalyzerResult } from '../types';
import { claudeSpawnEnv } from './aiProvider';
import { godSpawnEnv } from './godclaude';
import { resolveExecutable, wrapForWindows } from './exec';

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

async function runClaude(
  prompt: string,
  cwd: string,
  timeoutMs: number = CLAUDE_TIMEOUT_MS,
): Promise<string> {
  // Resolve `claude` to a full path (and route a .cmd/.bat shim through cmd.exe
  // on Windows). Passing the bare name let libuv find claude.cmd and then throw
  // EINVAL — surfaced as a misleading "not on PATH" error — for npm-global
  // installs, which is how Claude Code is normally installed on Windows.
  const claudeBin = resolveExecutable('claude');
  const { file, args } = wrapForWindows(claudeBin, ['-p', prompt, '--output-format', 'json']);
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      // Headless analysis sessions are NARUKAMI sessions too — same embedded
      // godclaude home as the interactive terminals, and the same configured AI
      // credential (empty in the default 'claude-code' mode). In headless mode
      // an injected ANTHROPIC_API_KEY is always used, with no approval prompt.
      env: { ...process.env, ...godSpawnEnv(), ...claudeSpawnEnv() },
    });
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

export interface EodProjectInput {
  name: string;
  commitsText: string;
  runsText: string;
  sessions: number;
  /** Per-session digests from {@link summarizeSession}, in chronological order. */
  sessionDigests: string[];
  /** Sessions that existed but weren't digested (budget cap) — reported, never hidden. */
  sessionsOmitted: number;
}

// A session digest reads one transcript's worth of material — more runway than
// the 2-minute project-analysis budget, but far less than the final report.
const SESSION_DIGEST_TIMEOUT_MS = 180_000;

// The roll-up ingests every digest for every project at once; the old 2-minute
// default was sized for a single thin prompt and would kill a real day's report.
const EOD_REPORT_TIMEOUT_MS = 300_000;

/**
 * Layer 1 of the EOD pipeline: turn ONE Claude session into a detailed digest.
 *
 * The report used to be written in a single pass over a merged blob of user
 * prompts, which is why it came out vague — nothing ever read a session as a
 * unit. This reads one session at a time so the model can actually follow what
 * was asked, what was done, and how it ended, before anything is summarized
 * across the day.
 *
 * `sessionText` comes from eodSessions.sessionToPromptText (both sides of the
 * conversation plus tool/file evidence). Returns markdown; failures are the
 * caller's to handle (a dead session must not sink the whole report).
 */
export async function summarizeSession(
  cwd: string,
  projectName: string,
  sessionText: string,
): Promise<string> {
  const prompt = `You are summarizing ONE Claude Code working session on the project "${projectName}", for a developer's end-of-day report.

Read the session material below and write a DETAILED, factual account of that session.

Output EXACTLY this markdown and nothing else (no preamble, no code fences):

**<a short specific title for this session, max 9 words>**
- **Goal:** <what the developer set out to do, in their terms>
- **Work:** <3-6 bullets of what was actually done — specific changes, files, commands, findings. Merge trivia into meaningful units.>
- **Outcome:** <what state it ended in: what works, what shipped, what was verified>
- **Open:** <anything unresolved, deferred, or explicitly left for later — or "nothing outstanding">

Hard rules:
- Be SPECIFIC. Name the real files, features, commands, errors and decisions that appear in the material. "Worked on the UI" is a failure; "Added a Settings tab with an API-key field wired to the backend" is right.
- Derive EVERYTHING from the material. Never invent a file, number, test result or outcome that isn't there.
- The assistant's narration says what it intended; the tool/file evidence says what it touched. Prefer the evidence when they disagree.
- If the session is thin or exploratory, say so plainly rather than padding it.
- Past tense. No filler, no restating these instructions.

Session material:
${sessionText}`;

  const stdout = await runClaude(prompt, cwd, SESSION_DIGEST_TIMEOUT_MS);
  return stripFences(unwrapEnvelope(stdout)).trim();
}

/**
 * Generate a cross-project End-of-Day report for `prettyDate` in the FIXED
 * template format (## EOD -- date → ### Project bullets → ### Summary). One
 * `claude -p` call over every selected project's git commits + runs + session
 * activity. Returns markdown with any surrounding code fence stripped.
 */
export async function generateEodReport(
  cwd: string,
  prettyDate: string,
  projects: EodProjectInput[],
  note: string,
): Promise<string> {
  const blocks = projects
    .map((p) => {
      const digests = p.sessionDigests.length
        ? p.sessionDigests.map((d, i) => `--- SESSION ${i + 1} OF ${p.sessions} ---\n${d}`).join('\n\n')
        : '(no session digests — fall back to the commits and runs below)';
      const omitted =
        p.sessionsOmitted > 0
          ? `\nNOTE: ${p.sessionsOmitted} further session(s) that day were not digested (per-report budget). Say so if the day looks incomplete.`
          : '';
      return `## PROJECT: ${p.name}  (${p.sessions} Claude session(s) in range)

Per-session digests, in chronological order — THIS IS THE PRIMARY SOURCE:
${digests}${omitted}

Git commits in range (subject + body):
"""
${p.commitsText.slice(-6000) || '(no commits in range)'}
"""

Runs that finished in range:
"""
${p.runsText.slice(-1500) || '(none recorded)'}
"""`;
    })
    .join('\n\n');

  const prompt = `You are writing a developer's End-of-Day report for ${prettyDate}.

Each project below arrives as a set of PER-SESSION digests (written from the full session transcripts), plus that project's git commits and runs. Your job is the final layer: reorganize that raw material into a clean, professional report grouped BY THEME.

The audience is a colleague or manager who is NOT reading the code. They want to understand what was accomplished and why it matters — not how it was implemented.

Output EXACTLY this markdown structure and NOTHING else (no preamble, no explanation, no code fences):

## EOD — ${prettyDate}

### <Project Name>

#### <Theme of work>
-   <a clear, plain-English accomplishment>
-   <an accomplishment that had several parts:>
    -   <the parts, one per line>
-   <another accomplishment>

#### <Next theme of work>
-   <...>

(3-7 themes per project, then repeat "### <Project Name>" for EACH project below, in the given order)

### Summary
-   <3-4 bullets: the through-line of the day, the most valuable outcomes, and — in the final bullet — anything that is still outstanding or unfinished.>

THEMES — how to group:
- Invent the theme names yourself from what actually happened, and name them for the AREA OF WORK. Good examples: "Environment & Infrastructure", "Console Consolidation", "User Interface", "Account Management", "Data & Pagination", "Workflow & Runtime Improvements", "Backend Improvements", "Packaging & Release".
- Group by theme, NEVER by session or by chronology. Work spread over three sessions that advanced one feature is ONE theme with the full story told once.
- Order themes so the most substantial work comes first.

LANGUAGE — this is the most important part:
- Write plain, professional English. Full sentences. Past tense.
- Say what was ACHIEVED and what it ENABLES, not how it was coded.
- BAN, in the report body: file paths and file names, function/variable/class names, line numbers, commit hashes, branch names, migration names, port numbers, test counts and pass/fail tallies, tool and library names, command lines, code in backticks, and any \`inline code\` formatting at all.
- Translate the specifics into outcomes. "Lifted the 1460px .sheet cap in tools/product/index.html" becomes "Rebuilt the console layout to use the full width of large displays." "Added src/db/pages.ts across eight modules" becomes "Introduced a reusable pagination framework across the application's data layer."
- Keep the substance and precision — this is a DETAILED report, just written for a human. Never flatten real work into "made improvements" or "worked on the UI"; say which capability was added, fixed or removed.
- Use a nested sub-list when one accomplishment naturally breaks into parts. Introduce it with a bullet ending in a colon.

TRUTH:
- Base everything on the material given. NEVER invent an accomplishment, capability or outcome that is not there.
- If a project has almost no signal, say so in one honest line rather than padding it.
- Do not mention sessions, transcripts, digests, the assistant, or this prompt. Report the WORK, not how the report was made.
${note ? `- The developer added this note — weave it in where it fits:\n"""\n${note.slice(0, 1500)}\n"""` : ''}

Projects (in order):

${blocks}`;

  const stdout = await runClaude(prompt, cwd, EOD_REPORT_TIMEOUT_MS);
  return stripFences(unwrapEnvelope(stdout)).trim();
}

export interface ReleaseNotesInput {
  product: string;
  version: string;
  /** CHANGELOG [Unreleased] section (pre-capped by the caller). */
  changelog: string;
  /** `git log --oneline` for the release range (pre-capped by the caller). */
  commits: string;
  /** Human description of the commit range, for the prompt. */
  rangeLabel: string;
}

export interface ReleaseNotes {
  /** Patch Note Summary — plain-language, non-developer, ≤~50 words. */
  summary: string;
  /** Patch Note Description — one "- " line per major change, newline-separated. */
  description: string;
}

// Release notes read a whole [Unreleased] section + a commit range — give the
// model more runway than the 2-minute analysis budget.
const RELEASE_NOTES_TIMEOUT_MS = 300_000;

/**
 * Write the SGA release patch notes (summary + description) from the CHANGELOG
 * [Unreleased] section + the release's git log, in the release-zip skill's
 * fixed format. One `claude -p` call returning JSON.
 */
export async function generateReleaseNotes(
  cwd: string,
  input: ReleaseNotesInput,
): Promise<ReleaseNotes> {
  const prompt = `You are writing the release patch notes for ${input.product} version ${input.version} (a packaged software release).

Source material A — the CHANGELOG's [Unreleased] section:
"""
${input.changelog || '(empty — fall back to the commit list)'}
"""

Source material B — git commits in this release (${input.rangeLabel}):
"""
${input.commits || '(none captured)'}
"""

Respond with ONLY a single minified JSON object and nothing else — no prose, no markdown fences:
{"summary": "...", "description": "..."}

"summary" is the Patch Note Summary — short and simple, written so a non-developer understands it at a glance. 2-3 short sentences, under ~50 words total. Lead with **${input.product} ${input.version}** (markdown bold), then say in plain everyday language what is better for the user. Hard rules:
- No technical jargon — no tool / component / file / code names, no acronyms (API, DOM, OTA, WS, etc.), no "release arc" framing, no version-history references, no numbers or counts.
- Describe user-visible benefits only — what someone can now do or what got smoother/more reliable — never how it works internally.
- If you can't say it simply, cut it. Shorter beats complete.

"description" is the Patch Note Description — one line per major change, each line starting with "- " and a past-tense action verb. Group related sub-changes into a single line, 1-2 sentences max per line. Cover, in order, whichever apply: major new features; UX/visual improvements; settings/configuration changes; logging/observability improvements; intelligence/skill/persona expansions; page-driving/browser capability changes; bug fixes (critical first); platform reliability; then a closing line summarizing the release's significance. Derive every claim from the source material — do not invent features. Concrete counts are allowed here (description only). Do not repeat the summary verbatim. Join the lines with \\n inside the JSON string.`;

  const stdout = await runClaude(prompt, cwd, RELEASE_NOTES_TIMEOUT_MS);
  const inner = unwrapEnvelope(stdout);
  const jsonText = extractJsonObject(inner);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new AnalyzerError('Could not parse the release notes JSON returned by Claude Code.', inner);
  }

  const obj = isRecord(parsed) ? parsed : {};
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  if (!summary || !description) {
    throw new AnalyzerError(
      'Claude Code did not return both a release summary and a description.',
      inner,
    );
  }
  return { summary, description };
}
