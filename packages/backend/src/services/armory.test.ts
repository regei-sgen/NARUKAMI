import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectArmory, flattenHooks, parseFrontmatter } from './armory';

describe('parseFrontmatter', () => {
  it('grabs top-level keys, strips quotes, keeps the first of duplicates', () => {
    const fm = parseFrontmatter('---\nname: my-skill\ndescription: "Do a thing."\nargument-hint: [x]\n---\nbody');
    expect(fm.name).toBe('my-skill');
    expect(fm.description).toBe('Do a thing.');
    expect(fm['argument-hint']).toBe('[x]');
  });
  it('returns {} when there is no frontmatter', () => {
    expect(parseFrontmatter('just a body')).toEqual({});
  });
});

describe('flattenHooks', () => {
  it('flattens events into matcher/command rows and defaults matcher to *', () => {
    const settings = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/x.sh' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
      },
    };
    const rows = flattenHooks(settings, 'global');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.event === 'Stop')?.matcher).toBe('*');
    expect(rows.find((r) => r.event === 'Stop')?.command).toBe('~/.claude/hooks/x.sh');
    expect(rows.find((r) => r.event === 'PreToolUse')?.matcher).toBe('Bash');
  });
  it('is empty for no/invalid hooks', () => {
    expect(flattenHooks({}, 'global')).toEqual([]);
    expect(flattenHooks(null, 'global')).toEqual([]);
  });
});

describe('collectArmory over a fixture ~/.claude + project', () => {
  let cdir: string;
  let projDir: string;
  const prev = process.env.ARGUS_CLAUDE_DIR;

  beforeEach(() => {
    cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'armory-c-'));
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'armory-p-'));
    process.env.ARGUS_CLAUDE_DIR = cdir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ARGUS_CLAUDE_DIR;
    else process.env.ARGUS_CLAUDE_DIR = prev;
    fs.rmSync(cdir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it('is fail-soft: all empty when nothing exists', () => {
    const a = collectArmory([]);
    expect(a.ok).toBe(true);
    expect(a.counts).toEqual({ skills: 0, hooks: 0, memory: 0, agents: 0, commands: 0 });
  });

  it('collects global skills/hooks/memory AND per-project skills/commands', () => {
    // global skill
    fs.mkdirSync(path.join(cdir, 'skills', 'g-skill'), { recursive: true });
    fs.writeFileSync(path.join(cdir, 'skills', 'g-skill', 'SKILL.md'), '---\nname: g-skill\ndescription: global skill\n---\nx');
    // global hooks
    fs.writeFileSync(path.join(cdir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'stop.sh' }] }] } }));
    // memory pin (MEMORY.md excluded)
    const mem = path.join(cdir, 'projects', 'C--Users-x', 'memory');
    fs.mkdirSync(mem, { recursive: true });
    fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# idx');
    fs.writeFileSync(path.join(mem, 'pin.md'), '---\nname: pin\ndescription: a pin\nmetadata:\n  type: feedback\n---\nbody');
    // per-project command + skill
    fs.mkdirSync(path.join(projDir, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.claude', 'commands', 'deploy.md'), '---\nname: deploy\ndescription: deploy cmd\n---\nx');
    fs.mkdirSync(path.join(projDir, '.claude', 'skills', 'p-skill'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.claude', 'skills', 'p-skill', 'SKILL.md'), '---\nname: p-skill\ndescription: proj skill\n---\nx');

    const a = collectArmory([{ name: 'proj', path: projDir }]);
    expect(a.skills.map((s) => s.name)).toEqual(['g-skill', 'p-skill']); // sorted, both scopes
    expect(a.skills.find((s) => s.name === 'p-skill')?.scope).toBe('project');
    expect(a.hooks.some((h) => h.event === 'Stop' && h.command === 'stop.sh' && h.scope === 'global')).toBe(true);
    expect(a.memory.some((m) => m.name === 'pin' && m.type === 'feedback' && m.project === 'x')).toBe(true);
    expect(a.commands.some((c) => c.name === 'deploy' && c.scope === 'project' && c.project === 'proj')).toBe(true);
    expect(a.counts.skills).toBe(2);
  });
});
