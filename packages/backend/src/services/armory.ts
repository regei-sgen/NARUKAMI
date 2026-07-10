import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, decodeProjectDir, parseMemoryNote } from './argus';

/**
 * Armory — a read-only inventory of the Claude Code "arsenal" available on this
 * machine: skills, hooks, memory pins, agents and commands, scoped GLOBAL
 * (~/.claude) and PER-PROJECT (each registered project's .claude/). Everything
 * here READS; nothing writes. Fail-soft: a missing/broken file yields an empty
 * default, never throws. Not filtered by the selected project — it shows it all.
 */

export type Scope = 'global' | 'project';

export interface ArmorySkill {
  name: string;
  description: string;
  scope: Scope;
  project?: string;
}
export interface ArmoryHook {
  event: string;
  matcher: string;
  command: string;
  scope: Scope;
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
  scope: Scope;
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

export interface ArmoryProject {
  name: string;
  path: string;
}

/** Grab top-level frontmatter keys (name/description/…) from a `.md` file. Pure. */
export function parseFrontmatter(raw: string): Record<string, string> {
  const m = raw.replace(/\0/g, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : '';
  const out: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (mm && !(mm[1] in out)) out[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Flatten a parsed settings object's `hooks` into flat rows. Pure. */
export function flattenHooks(settings: unknown, scope: Scope, project?: string): ArmoryHook[] {
  const hooks = (settings as { hooks?: Record<string, unknown> } | null)?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const out: ArmoryHook[] = [];
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const matcher = typeof g?.matcher === 'string' && g.matcher ? g.matcher : '*';
      const inner = Array.isArray(g?.hooks) ? g.hooks : [];
      for (const h of inner) {
        const command = String(h?.command ?? h?.type ?? '').trim();
        if (command) out.push({ event, matcher, command, scope, project });
      }
    }
  }
  return out;
}

/** Read `<dir>/<name>/SKILL.md` for every subdir. Fail-soft. */
function readSkills(dir: string, scope: Scope, project?: string): ArmorySkill[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: ArmorySkill[] = [];
  for (const name of names) {
    try {
      const fm = parseFrontmatter(fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8'));
      out.push({ name: fm.name || name, description: fm.description || '', scope, project });
    } catch {
      // no SKILL.md / unreadable — skip
    }
  }
  return out;
}

/** Read flat `*.md` (agents / commands) with frontmatter. Fail-soft. */
function readDocs(dir: string, scope: Scope, project?: string): ArmoryDoc[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out: ArmoryDoc[] = [];
  for (const f of files) {
    try {
      const fm = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ name: fm.name || f.replace(/\.md$/i, ''), description: fm.description || '', scope, project });
    } catch {
      // skip
    }
  }
  return out;
}

function readHooksFile(file: string, scope: Scope, project?: string): ArmoryHook[] {
  try {
    return flattenHooks(JSON.parse(fs.readFileSync(file, 'utf8')), scope, project);
  } catch {
    return [];
  }
}

/** All memory pins under ~/.claude/projects/<hash>/memory, grouped by decoded project. */
function readAllMemory(): ArmoryMemory[] {
  const root = path.join(claudeDir(), 'projects');
  let projDirs: string[];
  try {
    projDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: ArmoryMemory[] = [];
  for (const proj of projDirs) {
    const memDir = path.join(root, proj, 'memory');
    let names: string[];
    try {
      names = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    } catch {
      continue;
    }
    const label = decodeProjectDir(proj).split('/').filter(Boolean).pop() || proj;
    for (const f of names) {
      try {
        const p = parseMemoryNote(fs.readFileSync(path.join(memDir, f), 'utf8'), f);
        out.push({ name: p.slug, description: p.description, type: p.type, project: label });
      } catch {
        // skip
      }
    }
  }
  return out;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

/**
 * Assemble the full Armory inventory: global (~/.claude) + per-project (.claude/)
 * for each registered project. Read-only, fail-soft.
 */
export function collectArmory(projects: ArmoryProject[]): Armory {
  const cdir = claudeDir();
  const projClaude = (p: ArmoryProject, ...seg: string[]): string => path.join(p.path, '.claude', ...seg);

  const skills = [
    ...readSkills(path.join(cdir, 'skills'), 'global'),
    ...projects.flatMap((p) => readSkills(projClaude(p, 'skills'), 'project', p.name)),
  ].sort(byName);

  const hooks = [
    ...readHooksFile(path.join(cdir, 'settings.json'), 'global'),
    ...readHooksFile(path.join(cdir, 'settings.local.json'), 'global'),
    ...projects.flatMap((p) => [
      ...readHooksFile(projClaude(p, 'settings.json'), 'project', p.name),
      ...readHooksFile(projClaude(p, 'settings.local.json'), 'project', p.name),
    ]),
  ];

  const agents = [
    ...readDocs(path.join(cdir, 'agents'), 'global'),
    ...projects.flatMap((p) => readDocs(projClaude(p, 'agents'), 'project', p.name)),
  ].sort(byName);

  const commands = [
    ...readDocs(path.join(cdir, 'commands'), 'global'),
    ...projects.flatMap((p) => readDocs(projClaude(p, 'commands'), 'project', p.name)),
  ].sort(byName);

  const memory = readAllMemory().sort(byName);

  return {
    ok: true,
    ts: new Date().toISOString(),
    skills,
    hooks,
    memory,
    agents,
    commands,
    counts: {
      skills: skills.length,
      hooks: hooks.length,
      memory: memory.length,
      agents: agents.length,
      commands: commands.length,
    },
  };
}
