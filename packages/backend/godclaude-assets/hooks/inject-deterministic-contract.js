#!/usr/bin/env node
// Injects the Deterministic Operating Contract as additionalContext.
// Event-agnostic: wired on SessionStart (main agent) AND SubagentStart (subagents);
// echoes back whatever hook_event_name it received so the payload is valid for both.
// MODE-AWARE: when a non-general GODCLAUDE mode is active, injects THAT mode's contract
// (~/.claude/modes/<mode>/contract.md); otherwise the base ~/.claude/deterministic-contract.md.
// Single source of truth for "which mode": ./godmode-mode.js (fail-safe => 'general').
// Fail-OPEN: if the contract is missing/unreadable/empty, emit nothing (never break a session).

'use strict';
const fs = require('node:fs');
const os = require('node:os');
// Guarded require: degrade to general/base inline if the shared resolver is missing/corrupt.
let resolveMode, resolveModes, readModeAsset, handoffGuidance, canonicalMode;
try { ({ resolveMode, resolveModes, readModeAsset, handoffGuidance, canonicalMode } = require('./godmode-mode.js')); }
catch (_) {}
if (typeof resolveModes !== 'function') resolveModes = (h, cwd) => { try { return [resolveMode ? resolveMode(h, cwd) : 'general']; } catch (_) { return ['general']; } };
if (typeof resolveMode !== 'function') resolveMode = () => 'general';
if (typeof readModeAsset !== 'function') readModeAsset = () => '';
if (typeof handoffGuidance !== 'function') handoffGuidance = () => '';
if (typeof canonicalMode !== 'function') canonicalMode = (x) => String(x || '').trim().toLowerCase();
// Per-session store (guarded) — read the `subagent-mode` overlay so a spawned SUBAGENT can run under a
// DIFFERENT mode than the parent session (mode delegation), honored ONLY on SubagentStart.
let STATE; try { STATE = require('./godstate-core.js'); } catch (_) { STATE = null; }
// Per-session shared-memory digest (optional; absent => no memory line).
let memDigest; try { ({ memDigest } = require('./godmem-core.js')); } catch (_) { memDigest = () => ''; }
// Honor DET_HOOKS_HOME (sandbox/tests) the same way the gate + resolver do.
const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const BASE_CONTRACT = `${HOME}/.claude/deterministic-contract.md`;

// Synchronous run(data) → output string, so godmode-gate.mjs can dispatch this in-process (no second
// `node` spawn). The CLI shim at the bottom preserves the original stdin→stdout→exit behavior.
function run(data) {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) {}
  const event = input.hook_event_name || 'SessionStart';
  // Coerce a non-string session_id to '' — exactly as inject-anti-drift + godmonitor do — so all three
  // hooks agree on which session is in force (a malformed numeric id can't surface memory here only).
  const sid = typeof input.session_id === 'string' ? input.session_id : '';
  let text = '';
  try {
    // input.cwd path-gates scoped modes; sid isolates this session. A session can run MULTIPLE modes —
    // inject each active mode's contract.md (primary first), concatenated. For a single mode this is
    // byte-for-byte the old behavior (the join of one element is that element).
    // SUBAGENT MODE DELEGATION: on SubagentStart, if the parent set a `subagent-mode`, the SUBAGENT runs
    // under THAT mode's contract (not the parent's), so a mode can delegate a sub-task to another mode's
    // discipline. Only on SubagentStart; the main agent (SessionStart) always uses the session's own modes.
    let modes = null;
    if (event === 'SubagentStart' && STATE && sid) {
      try {
        const raw = (STATE.readState(HOME, sid, 'subagent-mode') || '').trim();
        const c = raw ? canonicalMode(raw) : '';
        if (c && c !== 'general' && readModeAsset(HOME, c, 'contract.md').trim()) modes = [c];
      } catch (_) {}
    }
    if (!modes) modes = resolveModes(HOME, input.cwd, sid);
    const parts = [];
    for (const m of modes) { if (!m || m === 'general') continue; const c = readModeAsset(HOME, m, 'contract.md'); if (c && c.trim()) parts.push(c.trim() + handoffGuidance(m)); }
    if (parts.length) text = parts.join('\n\n---\n\n');
    if (!text || !text.trim()) text = fs.readFileSync(BASE_CONTRACT, 'utf8'); // fall back to the base contract
    // Surface this session's shared memory (isolated per session) so every mode + subagent sees it.
    // ONLY for a real session id — mirrors the `if (sid)` guard in inject-anti-drift + godmonitor so a
    // no-session SessionStart never surfaces the global-fallback store (keeps legacy output byte-parity).
    if (sid) { let mem = ''; try { mem = memDigest(HOME, sid, { maxItems: 8, maxTotal: 480 }); } catch (_) {} if (mem && mem.trim()) text = `${text}\n\n${mem.trim()}`; }
  } catch (_) { return ''; }
  if (!text || !text.trim()) return '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text }
  });
}

module.exports = run;
if (require.main === module) {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => { let out = ''; try { out = run(data); } catch (_) { out = ''; } if (out) process.stdout.write(out); process.exit(0); });
}
