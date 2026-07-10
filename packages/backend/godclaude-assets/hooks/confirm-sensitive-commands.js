#!/usr/bin/env node
'use strict';
// confirm-sensitive-commands.js — PreToolUse guard for the GODCLAUDE deterministic layer.
//
// Forces an EXPLICIT user confirmation before a sensitive shell command runs. It does NOT
// hard-block and it does NOT run anything itself: it returns permissionDecision:"ask" so Claude
// Code shows YOU the approve/deny prompt. Deny → Claude hands you the command instead of running it.
// This is the hard-enforcement "belt" behind the goddev contract's propose-only "Boundaries" section:
// stay in the local tree — never git push, deploy, or touch prod/secrets without your explicit OK.
//
// SCOPED BY DATA, NOT CODE: the patterns live in the ACTIVE mode's gate.json under "confirmCommands".
// Only a mode that defines that array enforces anything — today that is the developer mode (goddev,
// which now also covers the merged debugger + ui-ux work).
// general / qa / researcher / data-analyst / reviewer / planner ship none → this hook is a no-op there.
// ci-cd (godship) MUST NOT define confirmCommands: its whole job is to deploy and observe it green.
//
// Wired (THROUGH godmode-gate.mjs, so it stays dormant until the layer is armed) on:
//   PreToolUse   matcher "Bash|PowerShell"
//
// Input  (stdin JSON): { tool_name, tool_input: { command }, hook_event_name }
// Output (stdout JSON, exit 0): { hookSpecificOutput: { hookEventName, permissionDecision:"ask", permissionDecisionReason } }
//   permissionDecision "ask" = prompt the user (verified against Claude Code hooks docs).
// Fail-OPEN: any error / unparsable input / no matching rule → emit nothing, exit 0 (ALLOW). A guard
// must never trap a session: when in doubt about parsing, we allow; the matching itself fails CLOSED
// (broad patterns, per-segment) so a real push/deploy/secret is caught.

const os = require('node:os');
// Guarded require: if the shared resolver is missing/corrupt (partial install), degrade to a no-op
// (general / no config) inline rather than throwing — the guard then simply allows. Fail-safe.
let resolveMode, resolveModes, loadGateConfig, combineGateConfigs;
try { ({ resolveMode, resolveModes, loadGateConfig, combineGateConfigs } = require('./godmode-mode.js')); }
catch (_) {}
if (typeof resolveModes !== 'function') resolveModes = () => ['general'];
if (typeof resolveMode !== 'function') resolveMode = () => 'general';
if (typeof loadGateConfig !== 'function') loadGateConfig = () => ({});
if (typeof combineGateConfigs !== 'function') combineGateConfigs = (h, modes) => { try { return loadGateConfig(h, (Array.isArray(modes) ? modes : [modes])[0]); } catch (_) { return {}; } };

const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const SHELL = new Set(['Bash', 'PowerShell']); // the tools that actually run shell commands

// BASE propose-only guard (WP-1.4). Previously confirmCommands lived ONLY in per-mode gate.json, so only
// developer + web-builder guarded `git push` — general / autopilot / qa / researcher / planner / reviewer /
// data-analyst had NO push confirmation at all (the most common sessions were unguarded). This BASE set
// applies in EVERY mode so the propose-don't-push boundary holds everywhere, with ONE exception: ci-cd
// (godship), whose entire job is to ship — it opts out (see run()). The git-push pattern is the audit's
// corrected regex: it consumes `-C <dir>` / `-c k=v` option-args (incl. quoted paths with spaces like
// `git -C "C:/My Repo" push`) that the old `(?:-\S+\s+)*` form let bypass. Kept git-push-only to avoid
// false prompts; per-mode gate.json still adds mode-specific guards (developer/web-builder: publish/docker).
const BASE_CONFIRM = [
  { base: true, label: 'git push', pattern: '\\bgit\\s+(?:-\\S+(?:\\s+(?:"[^"]*"|\'[^\']*\'|[^\\s"\'])+)?\\s+)*push\\b' },
];

// Compile one confirmCommands entry — a {label, pattern} object (preferred) or a bare regex string —
// into {label, re}. A malformed regex is skipped, never fatal.
function compile(entry) {
  const src = (entry && typeof entry === 'object') ? entry.pattern : entry;
  const label = (entry && typeof entry === 'object' && entry.label) ? entry.label : 'sensitive command';
  const base = !!(entry && typeof entry === 'object' && entry.base);
  if (typeof src !== 'string' || !src) return null;
  try { return { label, base, re: new RegExp(src, 'i') }; } catch (_) { return null; }
}

// Split a command line into independently-tested segments. Testing per-segment means
// `git status && echo push` does NOT trip the git-push rule (neither segment has both git AND push),
// while `git add -A && git push` DOES (the push lives in its own segment). A real single invocation
// is always one segment, so this never MISSES a push/deploy — it only avoids cross-segment collisions.
function segments(cmd) {
  return String(cmd).split(/\n|;|&&|\|\||\|/).map(s => s.trim()).filter(Boolean);
}

// Plain-English ("layman's") explanation of WHAT the matched action does and WHY it needs your OK, so the
// approve/deny prompt is understandable without knowing the tooling. Keyed off the rule label (generic
// fallback). This is the human-readable half of the propose-only boundary.
function laymanExplain(label) {
  const l = String(label || '').toLowerCase();
  if (/push/.test(l)) return 'In plain terms: this uploads your local code changes to the shared/online repository, where your team (and anyone with access) can see and pull them — hard to take back once it is up.';
  if (/deploy|ship|pages|rollout/.test(l)) return 'In plain terms: this pushes your code/site OUT to a live environment — making it real for actual users right now.';
  if (/publish|package|image/.test(l)) return 'In plain terms: this publishes a package or container image to a public/shared registry that others will download — hard to unpublish.';
  if (/infra|terraform|kubectl|helm|pulumi|ansible|apply|destroy/.test(l)) return 'In plain terms: this changes LIVE cloud infrastructure (servers, clusters) — it can create, alter, or DELETE real resources.';
  if (/cloud|aws|gcloud|azure|\baz\b/.test(l)) return 'In plain terms: this changes live cloud resources directly (storage, functions, stacks) — real, possibly costly, possibly irreversible.';
  if (/secret|credential|key|token|password|\.env/.test(l)) return 'In plain terms: this reads or moves a SECRETS file (passwords, keys, tokens). Exposing or copying these is a security risk.';
  return 'In plain terms: this action reaches OUTSIDE your local project — it ships, publishes, or touches live/sensitive things — so it needs your explicit go-ahead.';
}

// Synchronous run(data) → output string, so godmode-gate.mjs can dispatch this in-process (no second
// `node` spawn). The CLI shim at the bottom preserves the original stdin→stdout→exit behavior.
function run(data) {
  try {
    let input = {};
    try { input = JSON.parse(data || '{}'); } catch (_) { return ''; } // unparsable → allow
    if (!SHELL.has(input.tool_name)) return '';                          // not a shell tool → allow
    const command = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : '';
    if (!command.trim()) return '';

    // Active mode SET for THIS session (session_id isolates; cwd path-gates). confirmCommands is the
    // UNION across active modes, so if developer is one of several active modes its push/deploy guard
    // still applies. For a single mode this equals the old loadGateConfig(mode).confirmCommands.
    let modes = ['general'];
    try { modes = resolveModes(HOME, input.cwd, input.session_id); } catch (_) {}
    const realModes = modes.filter(m => m && m !== 'general');
    const mode = realModes.join('+') || 'general';
    let cfg = {};
    try { cfg = combineGateConfigs(HOME, modes) || {}; } catch (_) {}
    const modeRules = Array.isArray(cfg.confirmCommands) ? cfg.confirmCommands.map(compile).filter(Boolean) : [];
    // BASE rules apply in every mode EXCEPT ci-cd (godship), whose job is to ship. Base first so a bare
    // `git push` shows the layer-wide propose-only reason even in a mode that ships no confirmCommands.
    const baseRules = realModes.includes('ci-cd') ? [] : BASE_CONFIRM.map(compile).filter(Boolean);
    const rules = [...baseRules, ...modeRules];
    if (!rules.length) return '';                                        // ci-cd (no base, no mode) → allow
    // The mode(s) that ACTUALLY ship confirmCommands — used to point the remediation hint at a REAL
    // gate.json dir (not the '+'-joined multi-mode label, which is not a folder). Single-mode => itself.
    const ownerModes = realModes.filter(m => { try { return (loadGateConfig(HOME, m).confirmCommands || []).length > 0; } catch (_) { return false; } });
    const gateHint = (ownerModes.length ? ownerModes : realModes).map(m => `~/.claude/modes/${m}/gate.json`).join(' and ') || `~/.claude/modes/${mode}/gate.json`;

    const segs = segments(command);
    let hit = null;
    for (const r of rules) { if (segs.some(s => r.re.test(s))) { hit = r; break; } }
    if (!hit) return '';                                                 // nothing sensitive → allow

    const event = input.hook_event_name || 'PreToolUse';
    const shown = command.length > 200 ? command.slice(0, 200) + '…' : command;
    // A base-rule hit is layer-wide (every mode but ci-cd); a mode-rule hit is scoped to the active mode.
    const scope = hit.base ? 'GODCLAUDE layer' : `GODCLAUDE ${mode} mode`;
    const adjustHint = hit.base
      ? `(This is the layer-wide propose-only guard in ~/.claude/hooks/confirm-sensitive-commands.js; ci-cd/godship mode is exempt.)`
      : `(Adjust or remove this guard: edit "confirmCommands" in ${gateHint}.)`;
    const reason =
      `${scope} boundary — this looks like a "${hit.label}" action, treated as ` +
      `PROPOSE-ONLY (no git push / deploy / secret-touching without your explicit OK).\n\n` +
      `${laymanExplain(hit.label)}\n\n` +
      `Command: ${shown}\n\n` +
      `Approve to run it now, or deny and have the command handed to you to run yourself. ` +
      `${adjustHint}`;

    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event, permissionDecision: 'ask', permissionDecisionReason: reason }
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
