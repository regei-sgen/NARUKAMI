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

const os = require('node:os');
let STATE; try { STATE = require('./godstate-core.js'); } catch (_) { STATE = null; } // per-session store
const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');

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
