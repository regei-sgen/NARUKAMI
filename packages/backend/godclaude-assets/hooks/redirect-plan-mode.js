#!/usr/bin/env node
'use strict';
// redirect-plan-mode.js — PreToolUse guard: GODPLAN owns planning while the layer is armed.
//
// Claude Code ships a built-in plan mode (the EnterPlanMode tool). When the GODCLAUDE layer is
// armed, a planning task must run under the godplan (planner) contract — grounded in the real
// code, alternatives + risks named, verifiable steps — NOT under the generic built-in plan mode,
// which enforces none of that. Contract text alone proved insufficient (the model still reached
// for EnterPlanMode on "make a plan" prompts), so this hook enforces it DETERMINISTICALLY:
//
//   EnterPlanMode call while armed  →  permissionDecision:"deny" + the godplan discipline in the
//   reason, AND (when no explicit mode pin is set) the session's mode is switched to planner so
//   the per-turn reminder + Stop gate enforce godplan from this turn on.
//
// Respects an EXPLICIT pin: a user-picked mode (node godmode.mjs <mode>) is never overwritten —
// the call is still denied (planning still goes through godplan discipline), but the pinned mode
// set stays; the reason says how to switch explicitly.
//
// Wired (THROUGH godmode-gate.mjs, so it stays dormant until the layer is armed) on:
//   PreToolUse   matcher "EnterPlanMode"
//
// Input  (stdin JSON): { tool_name, tool_input, hook_event_name, session_id, cwd }
// Output (stdout JSON, exit 0): { hookSpecificOutput: { hookEventName, permissionDecision:"deny", permissionDecisionReason } }
// Fail-OPEN: any error / unparsable input / planner mode not installed → emit nothing (ALLOW).
// A guard must never trap a session on its own bug; the wrapper already keeps it dormant when off.

const os = require('node:os');
// Guarded requires: a partial install degrades to allow (fail-open), never a crash.
let R; try { R = require('./godmode-mode.js'); } catch (_) { R = {}; }
const resolveModes = R.resolveModes || (() => ['general']);
const listModes = R.listModes || (() => []);
const isPinned = R.isPinned || (() => false);
const readModeAsset = R.readModeAsset || (() => '');
const loadModeScope = R.loadModeScope || (() => []);
const withinScope = R.withinScope || (() => true);
const PRIMARY = R.PRIMARY || {};
let STATE; try { STATE = require('./godstate-core.js'); } catch (_) { STATE = null; }

const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');

// Synchronous run(data) → output string, so godmode-gate.mjs can dispatch this in-process.
function run(data) {
  try {
    let input = {};
    try { input = JSON.parse(data || '{}'); } catch (_) { return ''; }          // unparsable → allow
    if (input.tool_name !== 'EnterPlanMode') return '';                          // defensive; matcher already filters
    const sid = typeof input.session_id === 'string' ? input.session_id : '';
    const cwd = typeof input.cwd === 'string' ? input.cwd : '';

    if (!listModes(HOME).includes('planner')) return '';                         // planner not installed → allow
    // planner path-gated + cwd outside its scope → it could not activate here; don't deny a tool
    // in favor of a mode that cannot run (keeps the deny and the resolved mode in agreement).
    try { const sc = loadModeScope(HOME, 'planner') || []; if (sc.length && !withinScope(cwd, sc)) return ''; } catch (_) {}

    let modes = ['general'];
    try { modes = resolveModes(HOME, cwd, sid); } catch (_) {}
    const plannerActive = modes.includes('planner');
    let pinned = false; try { pinned = isPinned(HOME, sid); } catch (_) {}

    // Switch the session to planner (unpinned, like an autopilot switch) unless an explicit pick is
    // pinned or planner already runs. Only ANNOUNCE the switch if the write actually landed (a silent
    // write failure must not claim a mode the reminder + Stop gate won't be enforcing).
    let switched = false;
    if (!plannerActive && !pinned && STATE) {
      try { switched = !!STATE.writeState(HOME, sid, 'mode', 'planner\n'); } catch (_) {}
    }

    const rem = (readModeAsset(HOME, 'planner', 'reminder.txt') || '').trim();
    const modeState = plannerActive
      ? 'godplan (planner) is ALREADY the active mode — the plan is its deliverable.'
      : switched
        ? 'This session is now SWITCHED to godplan (planner) — its contract + proof gate govern from this turn.'
        : pinned
          ? `The active mode is explicitly pinned (${modes.filter(m => m !== 'general').join('+') || 'general'}) and was kept — plan under godplan's grounding rules anyway, or switch explicitly: node ~/.claude/godmode.mjs godplan.`
          : 'The mode could not be persisted — still plan under godplan\'s grounding rules this turn.';
    const reason =
      'GODCLAUDE layer — built-in plan mode is gated: planning runs under GODPLAN (' + (PRIMARY.planner || 'planner/architect') + '), ' +
      'not the generic EnterPlanMode flow. ' + modeState + '\n\n' +
      'Produce the plan DIRECTLY in your response under the godplan contract instead of entering plan mode:\n' +
      (rem ? rem + '\n\n' : '') +
      '(If the USER explicitly asked for Claude Code\'s built-in plan mode, tell them it is gated by the ' +
      'GODCLAUDE layer — they can press shift+tab to force it, or disarm the layer: node ~/.claude/godmode.mjs off.)';

    return JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name || 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }
    });
  } catch (_) {
    return ''; // fail-open: never trap a session on a guard bug
  }
}

module.exports = run;
if (require.main === module) {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => { let out = ''; try { out = run(data); } catch (_) { out = ''; } if (out) process.stdout.write(out); process.exit(0); });
}
