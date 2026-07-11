#!/usr/bin/env node
'use strict';
// godmonitor.js — SessionStart guardian for the GODCLAUDE mode system.
//
// ACTIVATES only when a god mode is in use (or was requested but lost its path) — general + healthy
// stays SILENT, exactly like the rest of the opt-in layer. On each session start it:
//   - runs a full health check (drift + integrity + plumbing) via godmonitor-core,
//   - writes a heartbeat to ~/.claude/godmonitor.log,
//   - injects a one-line confirmation when the active mode is intact, or a LOUD warning listing the
//     issues when the mode may not be enforcing what you expect (so a god mode never silently fails).
// Wired (through the opt-in wrapper) on SessionStart. Fail-OPEN: any error => emit nothing.

const os = require('node:os');
let core; try { core = require('./godmonitor-core.js'); } catch (_) { core = null; } // no core => no monitor => silent (handled in run() — must NOT exit at top level, since the in-process wrapper requires this module)
let STATE; try { STATE = require('./godstate-core.js'); } catch (_) { STATE = null; } // per-session store (GC + isolation)
let REVIEW; try { REVIEW = require('./godimprove-core.js'); } catch (_) { REVIEW = null; } // self-improvement engine — surfaces data-driven suggestions (closes the loop). Optional: missing => no self-review.
let senseEnabled, autoSessionEnabled; try { ({ senseEnabled, autoSessionEnabled } = require('./godsense-core.js')); } catch (_) {} // banner when auto-routing is on
// FALLBACKS read the sentinel DIRECTLY via the store if godsense-core is missing (a partial/half-upgrade) —
// so SessionStart still announces auto-pilot/routing (and the health check warns the module is gone)
// instead of falsely flipping to "auto-routing is OFF" and ASKING the user. Auto-routing is now driven by
// the single `autosession` (autopilot) flag — godsense/godsession were merged into it.
if (typeof autoSessionEnabled !== 'function') autoSessionEnabled = (h, sid) => { try { return !!STATE && STATE.flagOn(h, sid || '', 'autosession'); } catch (_) { return false; } };
if (typeof senseEnabled !== 'function') senseEnabled = (h, sid) => autoSessionEnabled(h, sid);
const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');

// Synchronous run(data) → output string, so godmode-gate.mjs can dispatch this in-process (no second
// `node` spawn). The CLI shim at the bottom preserves the original stdin→stdout→exit behavior.
function run(data) {
  if (!core) return ''; // godmonitor-core failed to load → stay silent (no monitor)
  let input = {}; try { input = JSON.parse(data || '{}'); } catch (_) {}
  const event = input.hook_event_name || 'SessionStart';
  // SessionStart 'source': startup | resume | clear | compact. We surface the autopilot choice on a real
  // new/resumed session, but NOT on 'compact' (a mid-session auto-summarize) — re-asking there would nag.
  const source = typeof input.source === 'string' ? input.source : '';
  const sid = typeof input.session_id === 'string' ? input.session_id : ''; // per-session isolation key
  // Garbage-collect stale session overlays so the per-session store stays bounded (cheap, fail-safe;
  // never removes THIS session). Skipped on mid-session 'compact' (only real session starts).
  if (STATE && typeof STATE.gcSessions === 'function' && source !== 'compact') { try { STATE.gcSessions(HOME, { keepSid: sid }); } catch (_) {} }
  try {
    const hc = core.healthCheck(HOME, input.cwd, sid);
    const sensingOn = (() => { try { return senseEnabled(HOME, sid); } catch (_) { return false; } })(); // sense OR session OR autopilot
    const autoOn = (() => { try { return autoSessionEnabled(HOME, sid); } catch (_) { return false; } })(); // aggressive auto-pilot

    // Heartbeat on EVERY session start (even general) so godmonitor.mjs has a liveness trail. Size-capped.
    core.logHeartbeat(HOME, { event, requested: hc.requested, effective: hc.effective, drift: hc.drift, ok: hc.ok, sensing: sensingOn, autopilot: autoOn, issues: hc.issues });

    // Build the injected message from any parts that apply. Silent only when NOTHING applies (general,
    // healthy, no drift, auto-routing off) — consistent with the opt-in philosophy.
    const parts = [];
    if (autoOn) {
      // AUTO-PILOT (the single auto-routing switch — godsense/godsession were merged into it): active for
      // this session IMMEDIATELY (no asking). Each task is sensed and the matching GOD MODE switched in; a
      // confident signal switches even mid-session, an ambiguous follow-up keeps the current mode; normal
      // Claude only for genuinely easy prompts. Each switch is announced + names the mode.
      parts.push(`[autopilot] AUTO-PILOT is ON — auto-routing is active for THIS session immediately. GODCLAUDE ` +
        `senses each task and switches to the matching god mode (goddev/godqa/godscout/goddata/godreview/godplan/godship) ` +
        `for most prompts — a confident signal switches even mid-session, an ambiguous follow-up keeps the current mode — ` +
        `and uses normal Claude ONLY for genuinely easy ones. Every switch is announced and names the active mode. ` +
        `An explicit pick — node ~/.claude/godmode.mjs <mode> — pins it. Turn off: node ~/.claude/godmode.mjs autopilot off`);
    } else if (source !== 'compact') {
      // EXPLICIT session-start choice (new + resumed sessions; NOT a mid-session 'compact'). Auto-routing is
      // OFF, so ask the user how to run THIS session: autopilot (auto-route modes) or normal Claude. Fires
      // regardless of which mode is currently set — the mode file persists across sessions, so the choice is
      // about auto-routing, not about whether a mode happens to be selected.
      parts.push(`[GODCLAUDE — session start] Auto-routing (autopilot) is OFF — this is normal Claude (you pick ` +
        `a mode per task: /goddev, /godqa, /godscout, …). Before substantive work, ASK the user how to run THIS ` +
        `session: with autopilot (GODCLAUDE senses each task and auto-switches modes) or stay on normal Claude. ` +
        `Enable autopilot: \`node ~/.claude/godmode.mjs autopilot on\` (effective from the next prompt). Their answer governs the session.`);
    }
    // Surface health issues even in general/no-drift (e.g. auto-routing configured but godsense-core.js is
    // missing => sensing silently dead) — the warning must not be suppressed just because no mode resolved.
    if (hc.effective !== 'general' || hc.drift || !hc.ok) {
      if (hc.ok) {
        // A session may run several modes at once — name them all (e.g. "qa+developer").
        const eff = (hc.effectiveModes || [hc.effective]).filter(m => m && m !== 'general');
        const modeLabel = eff.length ? eff.join('+') : hc.effective;
        const plural = eff.length > 1 ? 'modes' : 'mode';
        // Truthful path note. Don't assert "requested == effective" when it isn't — e.g. a multi-mode
        // set whose PRIMARY is a path-gated mode dormant outside its scope, with a non-scoped secondary
        // carrying the session (requested != effective, but correctly so).
        const reqLc = (hc.requested || 'general').toLowerCase();
        const pathNote = hc.autoActivated
          ? `auto-activated by path (cwd is inside its scoped dir; OFF everywhere else, isolated from the shipping pipeline)`
          : (hc.pathGatedDormant && reqLc !== hc.effective)
            ? `requested "${hc.requested}" is path-gated and OFF here (cwd outside its scope) — running ${modeLabel} instead`
            : (reqLc === hc.effective || reqLc === modeLabel)
              ? `path verified (requested == effective)`
              : `requested "${hc.requested}" → effective ${modeLabel}`;
        parts.push(`[godmonitor] ${modeLabel} ${plural} active and intact — the gate is enforcing ${modeLabel} ` +
          `proof rules; ${pathNote}. On-demand health: node ~/.claude/godmonitor.mjs`);
      } else {
        parts.push(`[godmonitor] ⚠ GOD MODE HEALTH ISSUE — the active mode may NOT be enforcing what you expect:\n` +
          hc.issues.map(i => `  - ${i}`).join('\n') +
          `\nFix: re-select with \`node ~/.claude/godmode.mjs ${hc.requested || hc.effective}\`, or reinstall ` +
          `(\`node install.mjs\`). Full report: \`node ~/.claude/godmonitor.mjs\`.`);
      }
    }
    // SELF-REVIEW (closing the improvement loop): surface the layer's OWN data-driven improvement
    // suggestions (from the perf + audit logs, via godimprove-core) so they stop being buried in a log
    // nobody runs and become live, actionable context. Advisory ONLY — never auto-applies (propose-don't-push).
    // Silent unless there's a high-signal item; capped + terse to keep the per-turn token cost low; skipped on
    // mid-session 'compact' (only real session starts, so it never nags during an auto-summarize).
    if (REVIEW && typeof REVIEW.selfReview === 'function' && source !== 'compact') {
      try {
        const r = REVIEW.selfReview(HOME);
        if (r && r.signal && r.items.length) {
          parts.push(`[GODCLAUDE self-review] the layer flagged ${r.items.length} improvement signal(s) from its own ` +
            `perf/audit logs (closing the loop — act on these, or run \`node ~/.claude/godmode-stats.mjs\` for the full report):\n` +
            r.items.map(i => `  - ${i}`).join('\n'));
        }
      } catch (_) {}
    }
    // NOTE: the per-session shared-memory digest is surfaced at SessionStart by the CONTRACT injector
    // (inject-deterministic-contract.js), which also feeds SubagentStart. We deliberately do NOT repeat
    // it here — duplicating it would show the same notes twice at startup and double the token cost.
    if (!parts.length) return '';
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: parts.join('\n') } });
  } catch (_) {}
  return '';
}

module.exports = run;
if (require.main === module) {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => { let out = ''; try { out = run(data); } catch (_) { out = ''; } if (out) process.stdout.write(out); process.exit(0); });
}
