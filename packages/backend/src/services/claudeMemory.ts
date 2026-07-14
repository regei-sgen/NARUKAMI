import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Bounds so a project with a huge memory tree can't blow up the response / prompt.
const MAX_DOCS = 40;
const MAX_DOC_CHARS = 8000;
const MAX_TOTAL_CHARS = 60_000;

export type MemorySource = 'index' | 'memory' | 'claude-md';

export interface MemoryDoc {
  source: MemorySource; // 'index' = MEMORY.md, 'memory' = a memory/*.md file, 'claude-md' = project CLAUDE.md
  name: string; // display name (file name, or relative path for CLAUDE.md)
  content: string; // file text (capped)
  truncated: boolean; // true if content was clipped to MAX_DOC_CHARS
}

/**
 * Claude Code stores per-project data under
 * `~/.claude/projects/<encoded-cwd>/`, where the directory name is the absolute
 * project path with every non-alphanumeric character replaced by '-'. Verified
 * against the live layout: `C:\Users\Stephanie Piape\Documents\NARUKAMI` ⇒
 * `C--Users-Stephanie-Piape-Documents-NARUKAMI` (drive colon + each separator +
 * the space in the user name all become single dashes, not collapsed). Pure.
 */
export function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Absolute path to a project's Claude memory directory (may not exist). */
export function projectMemoryDir(projectPath: string, home: string = homedir()): string {
  return join(home, '.claude', 'projects', encodeProjectDir(projectPath), 'memory');
}

/** Clip a document body to the per-doc cap, reporting whether it was clipped. */
export function capDoc(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_DOC_CHARS) return { content, truncated: false };
  return { content: content.slice(0, MAX_DOC_CHARS), truncated: true };
}

/**
 * Order memory docs for display/summary: the MEMORY.md index first, then the
 * individual memory files alphabetically, then any project-local CLAUDE.md.
 * Pure (operates on an already-collected list) so it's unit-testable.
 */
export function sortMemoryDocs(docs: MemoryDoc[]): MemoryDoc[] {
  const rank: Record<MemorySource, number> = { index: 0, memory: 1, 'claude-md': 2 };
  return [...docs].sort((a, b) => rank[a.source] - rank[b.source] || a.name.localeCompare(b.name));
}

/**
 * Read a project's Claude memory: the accumulated `~/.claude/projects/<enc>/memory/`
 * markdown (MEMORY.md index + individual memory files) plus any project-local
 * CLAUDE.md / .claude/CLAUDE.md. Returns [] if none exist or anything fails —
 * memory is an enrichment source for the EOD, never fatal. Capped in count + size.
 */
export async function readProjectMemory(
  projectPath: string,
  home: string = homedir(),
): Promise<MemoryDoc[]> {
  const docs: MemoryDoc[] = [];

  // 1. Claude Code's per-project memory directory.
  const memDir = projectMemoryDir(projectPath, home);
  try {
    const names = (await readdir(memDir)).filter((n) => n.toLowerCase().endsWith('.md'));
    for (const name of names) {
      if (docs.length >= MAX_DOCS) break;
      try {
        const raw = await readFile(join(memDir, name), 'utf8');
        const { content, truncated } = capDoc(raw);
        docs.push({
          source: name.toLowerCase() === 'memory.md' ? 'index' : 'memory',
          name,
          content,
          truncated,
        });
      } catch {
        // unreadable file — skip it
      }
    }
  } catch {
    // no memory directory for this project — that's fine
  }

  // 2. Project-local CLAUDE.md instructions (root, then .claude/).
  for (const rel of ['CLAUDE.md', join('.claude', 'CLAUDE.md')]) {
    if (docs.length >= MAX_DOCS) break;
    try {
      const raw = await readFile(join(projectPath, rel), 'utf8');
      const { content, truncated } = capDoc(raw);
      docs.push({ source: 'claude-md', name: rel, content, truncated });
    } catch {
      // absent — fine
    }
  }

  return sortMemoryDocs(docs);
}

/** One text blob of the memory docs for feeding the AI day-summary prompt. Pure. */
export function memoryToText(docs: MemoryDoc[]): string {
  let out = '';
  for (const d of sortMemoryDocs(docs)) {
    const block = `## ${d.name}\n${d.content}${d.truncated ? '\n…(truncated)' : ''}\n\n`;
    if (out.length + block.length > MAX_TOTAL_CHARS) {
      out += block.slice(0, Math.max(0, MAX_TOTAL_CHARS - out.length));
      break;
    }
    out += block;
  }
  return out.trim();
}
