#!/usr/bin/env node
// enforce-mode-tools.js — PreToolUse. Per-mode tool restriction, driven by gate.json `denyTools`.
//
// WHY A HOOK AND NOT A TOOL ALLOWLIST: modes are MAIN-SESSION context, not subagents. The `tools:`
// frontmatter allowlist only exists for subagent definitions (~/.claude/agents/*.md), and this
// harness has no agents dir — so there is no declarative way to scope a mode's tools. A PreToolUse
// deny is the only lever the main session has. redirect-plan-mode.js already uses exactly this
// shape for EnterPlanMode; this generalises it, reading the same gate.json the Stop gate and the
// confirm hook already read, so a mode's rules live in ONE file.
//
// This closes the audit's real finding: every mode had an IDENTICAL tool surface and was governed
// only by prose plus a post-hoc Stop gate — the wrong action was never made impossible, only
// punished afterwards.
//
// MODE: SHADOW by default (log the would-be denial, allow). Set GODMODE_TOOLGATE_ENFORCE=1 to
// actually deny. Shadow first is deliberate: an over-broad deny breaks real work, and the false
// positive rate is unknown until it has been observed on real sessions.
//
// Fail-OPEN on any error.

'use strict';
const fs = require('node:fs');
const os = require('node:os');

const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const CLAUDE_DIR = (process.env.CLAUDE_CONFIG_DIR || `${HOME}/.claude`).replace(/\\/g, '/');
const AUDIT = `${CLAUDE_DIR}/hook-audit.log`;
const ENFORCE = process.env.GODMODE_TOOLGATE_ENFORCE === '1';

let resolveModes, resolveMode, loadGateConfig;
try { ({ resolveModes, resolveMode, loadGateConfig } = require('./godmode-mode.js')); } catch (_) {}
if (typeof resolveMode !== 'function') resolveMode = () => 'general';
if (typeof resolveModes !== 'function') resolveModes = (h, cwd, sid) => { try { return [resolveMode(h, cwd, sid)]; } catch (_) { return ['general']; } };
if (typeof loadGateConfig !== 'function') loadGateConfig = () => ({});

function audit(line) {
  try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [tool-gate] ${line}\n`); } catch (_) {}
}

function run(data) {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return ''; }
  const tool = input.tool_name || '';
  if (!tool) return '';

  let modes = [];
  try { modes = (resolveModes(HOME, input.cwd, input.session_id) || []).filter((m) => m && m !== 'general'); } catch (_) { modes = []; }
  if (!modes.length) return '';

  // Rules are the UNION across active modes, matching how confirmCommands and the Stop-gate
  // overrides already combine: if ANY active mode forbids a tool, it is forbidden.
  for (const mode of modes) {
    let cfg = {};
    try { cfg = loadGateConfig(HOME, mode) || {}; } catch (_) { continue; }
    const rules = Array.isArray(cfg.denyTools) ? cfg.denyTools : [];
    for (const r of rules) {
      const pattern = (r && typeof r === 'object') ? r.tool : r;
      if (typeof pattern !== 'string' || !pattern) continue;
      let re;
      try { re = new RegExp(`^(?:${pattern})$`, 'i'); } catch (_) { continue; }
      if (!re.test(tool)) continue;

      // An `except` regex lets a mode forbid a tool broadly but allow a carve-out — e.g. researcher
      // may not write source, but may write to a scratch dir.
      const exceptSrc = (r && typeof r === 'object') ? r.except : '';
      if (exceptSrc) {
        const target = String(
          (input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path || input.tool_input.command)) || ''
        ).replace(/\\/g, '/');
        try { if (new RegExp(exceptSrc, 'i').test(target)) continue; } catch (_) {}
      }

      const why = (r && typeof r === 'object' && r.reason) ? r.reason : `${mode} mode does not use ${tool}`;
      if (!ENFORCE) { audit(`SHADOW would-deny tool=${tool} mode=${mode} reason=${JSON.stringify(String(why).slice(0, 120))}`); return ''; }
      audit(`DENY tool=${tool} mode=${mode}`);
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `GODCLAUDE ${mode} mode does not permit ${tool}. ${why}\n\n` +
            `If this mode is wrong for the task, switch it: node ~/.claude/godmode.mjs <mode>. ` +
            `To change the rule itself, edit "denyTools" in ~/.claude/modes/${mode}/gate.json.`,
        },
      });
    }
  }
  return '';
}

module.exports = run;
if (require.main === module) {
  let data = '';
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    let out = '';
    try { out = run(data); } catch (_) { out = ''; }
    if (out) process.stdout.write(out);
    process.exit(0);
  });
}
