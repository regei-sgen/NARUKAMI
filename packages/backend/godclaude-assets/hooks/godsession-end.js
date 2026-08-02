#!/usr/bin/env node
'use strict';
// godsession-end.js — SessionEnd cleanup for the GODCLAUDE mode system.
//
// An explicit mode pick (`/godbug`, `node godmode.mjs <mode>`) is written to THIS session's overlay
// (godmode-sessions/<sid>/), so it is already private to the session that made it and never affects
// another session. What was missing: nothing cleared that overlay when the session actually ENDED, so
// a pick could linger up to the 14-day gcSessions cap. This hook closes that gap — when a session ends
// for good it removes that session's explicit PIN + selected MODE, so the pick is gone the moment the
// session is over and a later `claude --continue` of the same id starts clean (re-routes via godsense).
//
// SCOPED, NEVER GLOBAL: every clear uses scope:'session', which by contract (godstate-core.clearState)
// touches ONLY the overlay file and NEVER the global seed (~/.claude/godmode-mode) — so cleanup can't
// poison the machine-wide default or any other live session.
//
// CONTINUATIONS ARE PRESERVED: SessionEnd also fires for `resume` (suspended for later), `clear`
// (/clear resets context but the session continues), and `bypass_permissions_disabled` (toggling OFF
// bypass-permissions mode — the session keeps running) — those are NOT ends, so we leave the overlay
// intact and you keep your mode. Any other reason (logout, prompt_input_exit, other, or an unknown
// future reason) is treated as a genuine end and clears the pick. (KEEP_REASONS below is this list.)
//
// Wired (through the opt-in gate) on SessionEnd. SessionEnd stdout is ignored by Claude Code and the
// hook cannot block — so this returns '' and does its work as a side effect. Fail-safe: any error =>
// no-op. Honors DET_HOOKS_HOME (tests).

const fs = require('node:fs');
const os = require('node:os');
let STATE; try { STATE = require('./godstate-core.js'); } catch (_) { STATE = null; } // per-session store
const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const CLAUDE_DIR = `${HOME}/.claude`;

// ---- session outcome record -------------------------------------------------------------------
// The harness measured latencies and counters but never whether a session ACCOMPLISHED anything —
// there was no end-to-end signal of any kind, so "did that harness change help?" was unanswerable.
// This appends one JSONL line per session. Fields that cannot be derived honestly are OMITTED
// rather than written as a fake zero: a missing key means "not measured", which is a different
// claim from "measured zero", and conflating them is how a metric starts lying.
function writeOutcome(sid, reason) {
  const rec = { ts: new Date().toISOString(), sid: String(sid).slice(0, 64), reason: reason || 'unknown' };
  try {
    const modes = new Set();
    // Modes actually used this session, from the monitor heartbeats.
    try {
      const hb = fs.readFileSync(`${CLAUDE_DIR}/godmonitor.log`, 'utf8').trim().split('\n').slice(-400);
      for (const line of hb) {
        try { const j = JSON.parse(line); if (j && j.effective) modes.add(j.effective); } catch (_) {}
      }
    } catch (_) {}
    if (modes.size) rec.modes = [...modes];

    // Gate activity for THIS session is not attributable from hook-audit.log (its lines carry no
    // session id), so gateBlocks/gateVerifies are deliberately omitted rather than guessed. Wiring
    // the sid into the gate's audit lines is the prerequisite for adding them.
    const dir = `${CLAUDE_DIR}/godmode-sessions/${String(sid).replace(/[^A-Za-z0-9._-]/g, '_')}`;
    try {
      const counts = JSON.parse(fs.readFileSync(`${dir}/edit-counts.json`, 'utf8'));
      const files = Object.keys(counts);
      rec.filesMutated = files.length;
      rec.totalEdits = files.reduce((n, f) => n + counts[f], 0);
      const worst = files.sort((a, b) => counts[b] - counts[a])[0];
      if (worst) rec.maxEditsOneFile = counts[worst];
    } catch (_) { /* no edit-count state ⇒ omit, do not write 0 */ }

    fs.appendFileSync(`${CLAUDE_DIR}/session-outcomes.jsonl`, JSON.stringify(rec) + '\n');
  } catch (_) { /* outcome logging must never affect cleanup */ }
}

// Reasons that mean the session is CONTINUING, not ending-for-good — preserve its overlay so a resumed
// or context-cleared session keeps the mode it had. Everything else is a genuine end => clear the pick.
const KEEP_REASONS = new Set(['resume', 'clear', 'bypass_permissions_disabled']);

// Synchronous run(data) → string, so godmode-gate.mjs dispatches it in-process (no second `node` spawn).
function run(data) {
  if (!STATE) return '';
  let input = {}; try { input = JSON.parse(data || '{}'); } catch (_) { return ''; }
  const sid = typeof input.session_id === 'string' ? input.session_id : '';
  if (!sid) return '';                                   // no session id => no overlay to clear (never global)
  const reason = typeof input.reason === 'string' ? input.reason.trim().toLowerCase() : '';
  if (KEEP_REASONS.has(reason)) return '';               // resume / clear / … => a continuation; leave it intact
  writeOutcome(sid, reason);                             // record the outcome BEFORE the state it reads is cleared
  try {
    // Clear ONLY this session's overlay (scope:'session' never touches the global seed or other sessions).
    // Drop the explicit PIN + the selected MODE so the ended session resolves to the global seed again;
    // shared memory + flag overlays are intentionally LEFT for gcSessions to reap (a `--continue` keeps
    // its scratch memory), and they age out at the normal 14-day cap.
    STATE.clearState(HOME, sid, 'explicit', 'session');
    STATE.clearState(HOME, sid, 'mode', 'session');
    STATE.clearState(HOME, sid, 'godsite-scope', 'session');
    // WP-2.5: also clear DELEGATION state — a lingering `subagent-mode` meant a resumed session silently ran
    // its subagents under a stale delegated contract + gate for up to the 14-day GC cap, and a stale pending
    // `handoff` would surface into the resumed session. Both are session-overlay state and, like the mode pick,
    // should not survive a genuine end. (scope:'session' still never touches the global seed or other sessions.)
    STATE.clearState(HOME, sid, 'subagent-mode', 'session');
    STATE.clearState(HOME, sid, 'handoff', 'session');
  } catch (_) {}
  return '';
}

module.exports = run;
if (require.main === module) {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => { try { run(data); } catch (_) {} process.exit(0); });
}
