import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { claudeDir, decodeProjectDir } from './argus';
import { normPath } from './eodActivity';

/**
 * Per-SESSION transcript reading for the EOD report.
 *
 * The old `collectSessionContext` merged every session of a project into one
 * blob of user prompts, read only the FIRST 1 MiB of each transcript, kept 10
 * prompts of 220 chars each, and never looked at what Claude actually did. A
 * real day's transcript is tens of megabytes (12 MB is typical), so the report
 * was written from roughly the first 8% of the morning and nothing else — which
 * is why it read as vague.
 *
 * This module instead streams each transcript END TO END and returns one record
 * PER SESSION, carrying both sides of the conversation plus the tool/file
 * evidence of what was done. Bounded by construction: prompts and assistant
 * notes are kept head+tail so a long session contributes its start AND its
 * finish rather than being cut off at the first megabyte, and every drop is
 * counted so the caller can say the input was truncated instead of pretending
 * it was complete.
 *
 * Read-only and fail-soft: an unreadable or half-written transcript is skipped,
 * never fatal.
 */

export interface SessionRecord {
  sessionId: string;
  file: string;
  cwd: string;
  /** Claude Code's own generated session title ('ai-title' record), if present. */
  title: string | null;
  gitBranch: string | null;
  startedAt: string | null; // ISO, first in-window entry
  endedAt: string | null; // ISO, last in-window entry
  bytes: number;
  /** The developer's asks, in order (head + tail of a long session). */
  userPrompts: string[];
  /** Condensed assistant narration — what Claude said it was doing. */
  assistantNotes: string[];
  /** Tool name → invocation count, most-used first. */
  tools: Array<{ name: string; count: number }>;
  /** Distinct file paths the session read/edited/wrote. */
  files: string[];
  /** Sum of the session's reported turn durations (ms), when recorded. */
  activeMs: number;
  /** True when prompts/notes were dropped to stay bounded (report it, never hide it). */
  truncated: boolean;
}

/** Keeps the first and last N/2 items — a long session's start AND its finish. */
class HeadTail<T> {
  private head: T[] = [];
  private tail: T[] = [];
  private dropped = 0;
  constructor(private readonly cap: number) {}
  push(v: T): void {
    const half = Math.max(1, Math.floor(this.cap / 2));
    if (this.head.length < half) {
      this.head.push(v);
      return;
    }
    this.tail.push(v);
    if (this.tail.length > half) {
      this.tail.shift();
      this.dropped += 1;
    }
  }
  values(): T[] {
    return this.head.concat(this.tail);
  }
  lost(): number {
    return this.dropped;
  }
}

const MAX_PROMPTS = 40;
const MAX_NOTES = 40;
const MAX_FILES = 60;
const PROMPT_CHARS = 600;
const NOTE_CHARS = 400;

/** Text of a message's content, whether it's a plain string or block array. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join(' ');
}

/** Noise that isn't a real developer instruction (tool results, slash commands, injected blocks). */
function isRealPrompt(t: string): boolean {
  if (!t || t.length < 8) return false;
  if (t.startsWith('/')) return false; // slash command
  if (t.startsWith('<')) return false; // injected xml/system-reminder
  if (t.startsWith('[Request interrupted')) return false;
  if (/^Caveat: The messages below/i.test(t)) return false;
  return true;
}

interface Line {
  type?: string;
  subtype?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  aiTitle?: string;
  durationMs?: number;
  message?: { content?: unknown };
}

/**
 * Stream ONE transcript and build its record. `start`/`end` bound which entries
 * count, so a session that straddles midnight contributes only the part that
 * belongs to the requested window.
 */
export async function readSessionTranscript(
  file: string,
  start: Date,
  end: Date,
): Promise<SessionRecord | null> {
  let bytes = 0;
  try {
    bytes = fs.statSync(file).size;
  } catch {
    return null;
  }

  const prompts = new HeadTail<string>(MAX_PROMPTS);
  const notes = new HeadTail<string>(MAX_NOTES);
  const toolCounts = new Map<string, number>();
  const files = new Set<string>();
  let title: string | null = null;
  let cwd = '';
  let gitBranch: string | null = null;
  let sessionId = path.basename(file, '.jsonl');
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let activeMs = 0;
  let sawInWindow = false;

  const s = start.getTime();
  const e = end.getTime();

  let rl: readline.Interface;
  try {
    rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
  } catch {
    return null;
  }

  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line || line[0] !== '{') continue;
      let o: Line;
      try {
        o = JSON.parse(line) as Line;
      } catch {
        continue; // partial final line on a live session
      }

      if (!cwd && typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
      if (!gitBranch && typeof o.gitBranch === 'string' && o.gitBranch) gitBranch = o.gitBranch;
      if (typeof o.sessionId === 'string' && o.sessionId) sessionId = o.sessionId;
      // Claude's own title for the session — the best short label we can get.
      if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) {
        title = o.aiTitle.trim();
      }

      // Entries carrying a timestamp are windowed; untimestamped metadata is kept.
      if (typeof o.timestamp === 'string') {
        const t = Date.parse(o.timestamp);
        if (Number.isFinite(t)) {
          if (t < s || t >= e) continue;
          sawInWindow = true;
          if (!startedAt) startedAt = o.timestamp;
          endedAt = o.timestamp;
        }
      }

      if (o.type === 'system' && o.subtype === 'turn_duration' && typeof o.durationMs === 'number') {
        activeMs += Math.max(0, o.durationMs);
        continue;
      }

      const content = o.message?.content;
      if (o.type === 'user') {
        const t = messageText(content).replace(/\s+/g, ' ').trim();
        if (isRealPrompt(t)) prompts.push(t.slice(0, PROMPT_CHARS));
        continue;
      }
      if (o.type === 'assistant') {
        const t = messageText(content).replace(/\s+/g, ' ').trim();
        if (t.length >= 12) notes.push(t.slice(0, NOTE_CHARS));
        // Tool evidence: what was actually run/edited, not just what was said.
        if (Array.isArray(content)) {
          for (const b of content) {
            if (!b || typeof b !== 'object') continue;
            const blk = b as { type?: unknown; name?: unknown; input?: unknown };
            if (blk.type !== 'tool_use' || typeof blk.name !== 'string') continue;
            toolCounts.set(blk.name, (toolCounts.get(blk.name) ?? 0) + 1);
            const input = blk.input as { file_path?: unknown; path?: unknown } | undefined;
            const fp = input?.file_path ?? input?.path;
            if (typeof fp === 'string' && fp && files.size < MAX_FILES) files.add(fp);
          }
        }
      }
    }
  } catch {
    // Truncated/locked transcript — keep whatever we parsed.
  } finally {
    rl.close();
  }

  if (!sawInWindow) return null;

  return {
    sessionId,
    file,
    cwd,
    title,
    gitBranch,
    startedAt,
    endedAt,
    bytes,
    userPrompts: prompts.values(),
    assistantNotes: notes.values(),
    tools: [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    files: [...files],
    activeMs,
    truncated: prompts.lost() > 0 || notes.lost() > 0,
  };
}

/**
 * Every Claude session (native CLI + NARUKAMI) with activity in [start, end),
 * grouped by normalized cwd. File mtime is a cheap pre-filter; the real decision
 * is made per entry inside {@link readSessionTranscript}.
 */
export async function collectSessionsForRange(
  start: Date,
  end: Date,
): Promise<Map<string, SessionRecord[]>> {
  const out = new Map<string, SessionRecord[]>();
  const root = path.join(claudeDir(), 'projects');
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }

  const s = start.getTime();
  const e = end.getTime();
  for (const dir of dirs) {
    const dirPath = path.join(root, dir);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dirPath, f);
      // mtime pre-filter: a transcript last written before the window opened
      // cannot contain in-window entries, so skip the parse entirely.
      try {
        if (fs.statSync(full).mtimeMs < s) continue;
      } catch {
        continue;
      }
      const rec = await readSessionTranscript(full, start, end);
      if (!rec) continue;
      const cwd = rec.cwd || decodeProjectDir(dir);
      const key = normPath(cwd);
      const list = out.get(key);
      if (list) list.push({ ...rec, cwd });
      else out.set(key, [{ ...rec, cwd }]);
    }
  }

  // Chronological within each project — the report reads as the day unfolded.
  for (const list of out.values()) {
    list.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
  }
  void e;
  return out;
}

/** Total tool invocations in a session. */
function toolCalls(rec: SessionRecord): number {
  return rec.tools.reduce((a, t) => a + t.count, 0);
}

/**
 * Did anything worth reporting happen in this session?
 *
 * Headless `claude -p` calls write transcripts too — including the ones THIS
 * report makes to digest sessions — so a project's directory fills up with
 * one-shot stubs that carry a prompt or two, no files and no elapsed time. Left
 * unfiltered they outnumber the real sessions and, being the newest, crowd the
 * genuine work out of the digest budget. Measured separation on a real day was
 * wide: actual sessions touched 13-57 files over 13-250 minutes, the stubs
 * touched none in under a minute.
 */
export function isSubstantiveSession(rec: SessionRecord): boolean {
  return (
    rec.files.length >= 1 ||
    toolCalls(rec) >= 5 ||
    rec.activeMs >= 60_000 ||
    rec.userPrompts.length >= 4
  );
}

/** How much real work a session represents — ranks them for the digest budget. */
export function sessionSubstance(rec: SessionRecord): number {
  return (
    toolCalls(rec) +
    rec.files.length * 3 +
    rec.userPrompts.length * 2 +
    Math.round(rec.activeMs / 60_000)
  );
}

/** Compact, prompt-ready rendering of ONE session for the digest call. */
export function sessionToPromptText(rec: SessionRecord): string {
  const when = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '?');
  const mins = rec.activeMs > 0 ? ` · ~${Math.round(rec.activeMs / 60000)} min active` : '';
  const tools = rec.tools.length
    ? rec.tools.map((t) => `${t.name}×${t.count}`).join(', ')
    : '(no tool calls recorded)';
  const files = rec.files.length ? rec.files.join('\n') : '(none recorded)';
  return [
    `SESSION ${rec.sessionId}`,
    rec.title ? `Claude's own title: ${rec.title}` : '',
    `Window: ${when(rec.startedAt)} → ${when(rec.endedAt)}${mins}`,
    rec.gitBranch ? `Branch: ${rec.gitBranch}` : '',
    rec.truncated ? 'NOTE: very long session — the middle was dropped; start and end are shown.' : '',
    '',
    "The developer's messages, in order:",
    '"""',
    rec.userPrompts.length ? rec.userPrompts.map((p) => `- ${p}`).join('\n') : '(none captured)',
    '"""',
    '',
    'What the assistant said it was doing:',
    '"""',
    rec.assistantNotes.length ? rec.assistantNotes.map((n) => `- ${n}`).join('\n') : '(none captured)',
    '"""',
    '',
    `Tools used: ${tools}`,
    'Files touched:',
    '"""',
    files,
    '"""',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
