#!/usr/bin/env node
// Anti-drift: re-inject a TERSE contract reminder on every user prompt so the operating
// discipline stays in context through long sessions (especially after compaction, when the
// original SessionStart injection may have been summarized away).
// MODE-AWARE: injects the active mode's reminder (~/.claude/modes/<mode>/reminder.txt) when a
// non-general mode is active; otherwise the general reminder below. A session may run MULTIPLE
// modes — the primary mode's reminder is injected with a terse "(+ also enforcing: …)" suffix.
// SESSION-AWARE: all mode state is read/written through the per-session overlay (input.session_id),
// so two concurrent sessions never stomp each other's mode. Per-session shared memory is surfaced too.
// MAIN-AGENT ONLY: UserPromptSubmit fires for the main agent, so this per-turn re-injection covers the
// main agent. SUBAGENTS are not re-injected per turn — they receive the contract once at SubagentStart
// (inject-deterministic-contract.js) and are GOVERNED by the SubagentStop proof gate. So the contract's
// "binding … for any subagents" means enforced-for-subagents, not continuously re-injected into them.
// Pure context injection — never blocks. Fail-OPEN.
//
// OPT-IN keyword switch (default OFF): if the `keywords` flag is on (per-session or global), an
// anchored `godmode:<name>` token anywhere in the prompt switches + persists the mode for the rest of
// the session. The anchored `godmode:` prefix avoids matching bare English ("let's debug this").
//
// COST NOTE: this fires on EVERY UserPromptSubmit, so its length is a per-turn token tax. The
// general reminder is guarded by a length ceiling in _test-hooks.mjs; keep mode reminders terse too.

'use strict';
const fs = require('node:fs');
const os = require('node:os');
// Guarded require: degrade to general inline if the shared resolver is missing/corrupt.
let R; try { R = require('./godmode-mode.js'); } catch (_) { R = {}; }
const resolveMode = R.resolveMode || (() => 'general');
const resolveModes = R.resolveModes || ((h, cwd) => { try { return [resolveMode(h, cwd)]; } catch (_) { return ['general']; } });
const readModeAsset = R.readModeAsset || (() => '');
const canonicalMode = R.canonicalMode || (() => '');
const requestedMode = R.requestedMode || (() => '');
const requestedFolder = R.requestedFolder || (() => 'general');
const listModes = R.listModes || (() => []);
const activeScopedMode = R.activeScopedMode || (() => '');
const loadModeScope = R.loadModeScope || (() => []);
const isPinned = R.isPinned || (() => false);
const handoffGuidance = R.handoffGuidance || (() => '');
const PRIMARY = R.PRIMARY || {};
// autopilot auto-router engine (opt-in). Guarded: no-op if the module is missing.
let senseMode, senseEnabled, routeMode, autoSessionEnabled;
try { ({ senseMode, senseEnabled, routeMode, autoSessionEnabled } = require('./godsense-core.js')); }
catch (_) {}
if (typeof senseMode !== 'function') senseMode = () => null;
if (typeof senseEnabled !== 'function') senseEnabled = () => false;
if (typeof autoSessionEnabled !== 'function') autoSessionEnabled = () => false;
// routeMode encapsulates the routing policy (conservative vs aggressive auto-pilot). Fallback to the
// historical conservative behavior (= senseMode's mode, else stay) if the module predates it.
if (typeof routeMode !== 'function') routeMode = (p, cur, o) => { const s = senseMode(p); return s ? s.mode : null; };
// Per-session state store + shared memory (guarded; degrade to global-file writes / no memory).
let STATE; try { STATE = require('./godstate-core.js'); } catch (_) { STATE = null; }
let memDigest; try { ({ memDigest } = require('./godmem-core.js')); } catch (_) { memDigest = () => ''; }
// godmonitor-core: the SAME integrity check the SessionStart monitor uses (checkModeFolder). Reused for
// the per-turn integrity guard so the per-turn monitor can never diverge from SessionStart. Guarded:
// if it's missing (partial install) the per-turn integrity check simply degrades to a no-op.
let MON; try { MON = require('./godmonitor-core.js'); } catch (_) { MON = null; }
const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');

const GENERAL_REMINDER =
  '[Deterministic Operating Contract — active] Evidence-or-flag: the Stop-gate bounces any ' +
  'done/fixed/works claim made after file edits without post-edit verification (re-read the file ' +
  'or run a test). Also: decide before acting; read source (don\'t assume); research live/external ' +
  'facts on the web, don\'t recall them; re-audit before done; stick to the plan; fail closed; ' +
  'facts not self-promotion. Full: ~/.claude/deterministic-contract.md';

// Persist a mode selection to the per-session overlay (or the global file when there is no session id).
// Returns TRUE only if the mode actually persisted — callers gate the switch announcement + the full
// contract injection on this, so a silent write failure (disk full / permission) degrades to a no-op
// switch (stay in the prior mode) instead of announcing/injecting a switch the Stop gate won't enforce.
function persistMode(sid, modeVal, pin) {
  if (STATE) {
    const w = STATE.writeState(HOME, sid, 'mode', modeVal + '\n');
    if (pin && w) STATE.writeState(HOME, sid, 'explicit', 'explicit\n');
    return !!w;
  }
  try { fs.writeFileSync(`${HOME}/.claude/godmode-mode`, modeVal + '\n'); if (pin) fs.writeFileSync(`${HOME}/.claude/godmode-explicit`, 'explicit\n'); return true; } catch (_) { return false; }
}
// Is the in-prompt `godmode:<x>` keyword switch enabled (per-session overlay, else global)?
function keywordsEnabled(sid) {
  if (STATE) { try { return STATE.flagOn(HOME, sid, 'keywords'); } catch (_) { return false; } }
  try { return fs.existsSync(`${HOME}/.claude/godmode-keywords`); } catch (_) { return false; }
}

// Synchronous run(data) → output string, so godmode-gate.mjs can dispatch this in-process (no second
// `node` spawn). All file reads/writes below are synchronous; the CLI shim at the bottom preserves the
// original stdin→stdout→exit behavior for direct invocation (and the wrapper's spawn fallback).
function run(data) {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) {}
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  const sid = typeof input.session_id === 'string' ? input.session_id : ''; // per-session isolation key
  // Inside a scoped (path-gated) mode's dir, that mode OWNS routing — autopilot
  // yields to it silently. Empty when cwd is outside every scoped dir.
  let inScopedDir = ''; try { inScopedDir = activeScopedMode(HOME, cwd); } catch (_) {}

  // (0) GODSITE PROMPT-SCOPE TEARDOWN (deterministic). `node godmode.mjs web-builder --scope prompt` means
  // godsite serves exactly ONE request, then auto-deactivates. There is no post-turn hook for mode state, so
  // we realize "after this request" across two UserPromptSubmits: the FIRST prompt-scoped turn marks itself
  // served (web-builder stays active for it); the NEXT turn (here, BEFORE it resolves) tears web-builder down
  // so the follow-up prompt is no longer in godsite. Touches state ONLY when web-builder is prompt-scoped.
  try {
    if (STATE && typeof STATE.readState === 'function' && (STATE.readState(HOME, sid, 'godsite-scope') || '').trim() === 'prompt') {
      let wbActive = false; try { wbActive = resolveModes(HOME, cwd, sid).includes('web-builder'); } catch (_) {}
      if (wbActive) {
        if ((STATE.readState(HOME, sid, 'godsite-scope-served') || '').trim()) {
          persistMode(sid, 'general', false);                                          // the one request already ran → deactivate
          try { STATE.clearState(HOME, sid, 'explicit', 'session'); } catch (_) {}      // un-pin so autopilot/general resumes
          try { STATE.clearState(HOME, sid, 'godsite-scope', 'session'); } catch (_) {}
          try { STATE.clearState(HOME, sid, 'godsite-scope-served', 'session'); } catch (_) {}
        } else {
          try { STATE.writeState(HOME, sid, 'godsite-scope-served', 'served\n'); } catch (_) {} // serve THIS turn; tear down next
        }
      }
    }
  } catch (_) {}

  let explicitSwitch = false, senseNote = '';
  // The mode active BEFORE any switch this turn — so we can detect a real mid-session CHANGE and, when it
  // happens, inject the NEW mode's full contract (not just the terse reminder) so the switch is adopted
  // in depth, not just enforced by the gate. `switchedTo` = the new mode when the mode actually changed.
  let switchedTo = '';
  let prevMode = 'general'; try { prevMode = resolveMode(HOME, cwd, sid); } catch (_) {}

  // (1) OPT-IN explicit keyword switch — HIGHEST priority. `godmode:<name>` at a word boundary, only
  // when the keyword switch is enabled. Persist BEFORE resolving so this turn injects the new mode.
  // The anchored prefix avoids matching `godmode:` inside a pasted URL/path/code.
  try {
    if (keywordsEnabled(sid)) {
      const m = prompt.match(/(?:^|\s)godmode:\s*([a-z][a-z-]*)\b/i);
      if (m) {
        const canon = canonicalMode(m[1]);
        if (canon) {
          // explicit pick: persist it AND pin it (per-session) so autopilot will not override it later.
          // Only commit the switch (explicit flag + contract injection) if the write actually landed.
          try { if (persistMode(sid, canon, true)) { explicitSwitch = true; if (canon !== prevMode) switchedTo = canon; } } catch (_) {}
        } else {
          // a typed-but-unrecognized godmode: token is still explicit intent — do NOT let autopilot
          // override it this turn, and say the token was not recognized.
          explicitSwitch = true;
          senseNote = `[godmode] unknown mode "${m[1]}" — ignored (try goddev/godscout/goddata/godqa/godreview/godplan/godship/godsite). `;
        }
      }
    }
  } catch (_) {}

  // (2) AUTO-PILOT auto-router (the single auto-routing switch — godsense/godsession were merged into it).
  // Runs only when no explicit switch happened this turn, no explicit PIN is set (an explicit pick wins
  // until you change it), and autopilot is on for this session. It only switches to a mode that actually
  // LOADS, so it can never overwrite a working selection with an unloadable one. A confident signal
  // switches even across god modes (the active mode tracks the current task); an ambiguous/easy follow-up
  // keeps the current mode (preserves task context); ALWAYS announces the switch. The switch is written
  // to THIS session's overlay, so it never affects another session's mode.
  try {
    let pinned = false; try { pinned = isPinned(HOME, sid); } catch (_) {}
    // inScopedDir => a path-gated mode is in force here; it owns routing, so autopilot stands down.
    if (!explicitSwitch && !pinned && !inScopedDir && senseEnabled(HOME, sid)) {
      const cur = resolveMode(HOME, cwd, sid);
      const aggressive = autoSessionEnabled(HOME, sid); // autopilot is always aggressive: god modes preferred, normal only if easy
      const target = routeMode(prompt, cur, { aggressive });
      // routeMode returns a GOD MODE to switch to, or null to stay (it never forces 'general' — an easy
      // prompt stays put so a trivial ack can't churn away an active mode). Switch only to a mode that LOADS.
      if (target && target !== 'general' && target !== cur && listModes(HOME).includes(target)) {
        try {
          // Only announce + (later) inject the contract if the switch actually persisted — otherwise this
          // turn stays in the prior mode (banner, reminder, contract, and Stop gate all agree on it).
          if (persistMode(sid, target, false)) {
            switchedTo = target;
            const sensed = senseMode(prompt);
            const why = sensed ? `signals: ${sensed.hits.slice(0, 3).join(', ')}` : 'substantive task → default god mode';
            const godName = (R.GODNAME && R.GODNAME[target]) ? ` · ${R.GODNAME[target]}` : ''; // Kami pseudonym (display only; the machine-parsed banner keeps the bare id)
            senseNote = `[autopilot] switched to ${target}${godName} (${PRIMARY[target] || target}) — ${why}. Wrong? pick ` +
              `explicitly: node ~/.claude/godmode.mjs <mode>; stop auto-routing: node ~/.claude/godmode.mjs autopilot off. `;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  let reminder = '', driftWarn = '', modeLine = '', memLine = '', handoffLine = '';
  let resolvedPrimary = 'general'; // the ACTUALLY-resolved primary (after path-gating) — gates the contract inject
  try {
    const modes = resolveModes(HOME, cwd, sid);
    const primary = modes[0] || 'general';
    resolvedPrimary = primary;
    const extra = modes.filter((m, i) => i > 0 && m && m !== 'general');
    // EXPLICIT per-prompt mode banner — state plainly which mode(s) handle THIS prompt, every turn, so
    // it's never ambiguous which proof rules are in force. Reflects any switch made above.
    const label = primary === 'general' ? 'general (base contract)' : `${primary} (${PRIMARY[primary] || primary})`;
    const extraLabel = extra.length ? ` (+ also enforcing: ${extra.join(', ')})` : '';
    modeLine = `[GODCLAUDE] Active mode for this prompt: ${label}${extraLabel}. `;
    if (primary !== 'general') reminder = readModeAsset(HOME, primary, 'reminder.txt');
    if (extra.length) reminder = `${(reminder || GENERAL_REMINDER).trim()} [+ also enforcing ${extra.join(', ')} proof rules this turn.]`;
    // godmonitor (continuous, near-zero cost): if you asked for a mode that did NOT load, say so every
    // turn so a god mode can never silently "lose its path" mid-session. Emits text ONLY on drift.
    // A path-gated mode that's dormant because cwd is OUTSIDE its scope is NOT drift (suppress it).
    const req = requestedMode(HOME, sid);
    let reqScoped = false;
    try { const rf = requestedFolder(HOME, sid); reqScoped = rf !== 'general' && loadModeScope(HOME, rf).length > 0; } catch (_) {}
    if (req && req.toLowerCase() !== 'general' && primary === 'general' && !reqScoped) {
      driftWarn = `[godmonitor] ⚠ requested mode "${req}" is NOT loaded — running as "general". ` +
        `Re-select: node ~/.claude/godmode.mjs ${req} (or reinstall). `;
    }
    // godmonitor (per-turn INTEGRITY): the active mode(s) LOADED, but are they intact THIS turn? Run the
    // SAME check the SessionStart monitor uses (checkModeFolder) over EVERY active mode — primary AND each
    // secondary in a multi-mode set — so a mid-session corruption, a half-upgrade, an empty/keyless
    // gate.json, missing contract.md/reminder.txt, or a switch ONTO a broken mode is caught continuously,
    // not only at SessionStart, and the per-turn monitor never diverges from SessionStart. Warn-only; runs
    // only for non-general modes (the active set is 1–2 modes, so cost stays near-zero in the healthy case).
    // A broken mode silently contributes nothing to the combined gate — combineGateConfigs loads it as {}.
    if (MON && typeof MON.checkModeFolder === 'function') {
      for (const am of modes) {
        if (!am || am === 'general') continue;
        try {
          const mc = MON.checkModeFolder(HOME, am);
          if (mc && !mc.ok) driftWarn += `[godmonitor] ⚠ ${am} mode is active but its files are not intact (${mc.issues.join('; ')}) — its overrides are dropped this turn (the gate falls back to the remaining active modes + base). Reinstall: node ~/.claude/godmode.mjs status then node install.mjs. `;
        } catch (_) {}
      }
    }
    // Per-session SHARED MEMORY digest — only when there's a real session id (it is a session feature).
    // Surfaced every turn so all active modes + subagents in this session share the same notes. Bounded.
    if (sid) { try { const d = memDigest(HOME, sid, { maxItems: 5, maxVal: 56, maxTotal: 300 }); if (d && d.trim()) memLine = d.trim() + ' '; } catch (_) {} }
    // HANDOFF delivery (transparent collaboration): a `handoff <to> <ctx>` note left by another mode is
    // surfaced ONCE to the target mode the first turn it is active, then cleared (one-shot). It NEVER
    // switches the mode — it only delivers the context the previous mode left for this one.
    if (STATE && typeof STATE.readState === 'function') {
      try {
        const raw = STATE.readState(HOME, sid, 'handoff') || '';
        if (raw.trim()) {
          let h = null; try { h = JSON.parse(raw); } catch (_) {}
          // Clear the note from WHERE IT ACTUALLY LIVES: the session overlay if present, else the global
          // file it was read from via fallback. (A hook always has a sid, so the old `sid?'session':…`
          // could never clear a --global/no-session handoff → it re-surfaced every turn. This fixes that.)
          const clearHandoff = () => { try { let sp = ''; try { sp = STATE.sessionPath ? STATE.sessionPath(HOME, sid, 'handoff') : ''; } catch (_) {} STATE.clearState(HOME, sid, 'handoff', (sp && fs.existsSync(sp)) ? 'session' : 'global'); } catch (_) {} };
          const hto = h && h.to ? canonicalMode(h.to) : '';
          if (h && hto) {
            // Deliver to ANY active mode (primary OR a secondary in a multi-mode set) — the gate enforces
            // the whole set, so the handoff should reach whichever active mode it targets.
            if (hto !== 'general' && modes.includes(hto)) {
              const fromLbl = PRIMARY[h.from] || h.from || 'a previous mode';
              handoffLine = `[GODCLAUDE ⇢ handoff to ${PRIMARY[hto] || hto} from ${fromLbl}] ${String(h.context || '(no context provided)').slice(0, 400)} `;
              clearHandoff(); // one-shot: delivered, now clear
            }
            // else: a valid note still waiting for its target mode to become active — leave it queued.
          } else {
            clearHandoff(); // unparseable / structurally-invalid note can NEVER be delivered → self-heal (clear it)
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  if (!reminder || !reminder.trim()) reminder = GENERAL_REMINDER;
  if (!modeLine) modeLine = '[GODCLAUDE] Active mode for this prompt: general (base contract). '; // fail-safe if resolve threw

  // MID-SESSION SWITCH → inject the NEW mode's FULL contract this turn. The terse reminder keeps the rule
  // in view every turn; but when the mode actually CHANGES mid-session (autopilot routing or an explicit
  // godmode: keyword), the contract injected at SessionStart is for the OLD mode — so the agent would only
  // get the one-line reminder for the new role. Re-injecting the new mode's contract.md makes the switch a
  // REAL adoption of the new discipline (matching how SessionStart/SubagentStart deliver it). Cost is bounded
  // to switch turns only (rare relative to total turns), not every prompt.
  // Inject ONLY when the switched-to mode is the one actually RESOLVED for this turn (after path-gating).
  // If the requested mode gated out (e.g. a scoped mode picked from outside its dir → resolves to general),
  // switchedTo !== resolvedPrimary, so we suppress the contract — never inject a contract for a mode the
  // banner + Stop gate aren't enforcing (keeps the announcement, the contract, and the gate in agreement).
  let contractInject = '';
  if (switchedTo && switchedTo !== 'general' && switchedTo === resolvedPrimary) {
    try {
      const c = readModeAsset(HOME, switchedTo, 'contract.md');
      if (c && c.trim()) {
        contractInject = `\n\n[GODCLAUDE — MODE SWITCHED to ${switchedTo} (${PRIMARY[switchedTo] || switchedTo}) mid-session. ` +
          `Adopt this mode's FULL operating contract now — it governs this and following turns until the mode changes again:]\n${c.trim()}${handoffGuidance(switchedTo)}`;
      }
    } catch (_) {}
  }

  // HEARTBEAT ON A MID-SESSION SWITCH (gap #11): SessionStart writes a heartbeat, but a switch mid-session
  // (keyword or autopilot, above) changed the active mode — re-emit one so godmonitor's persistent trail
  // reflects the NEW mode's health (it must NOT keep reporting the SessionStart mode's ok:true for a session
  // now running a broken mode). Uses the SAME healthCheck the SessionStart monitor uses, so they never diverge.
  if (switchedTo && MON && typeof MON.logHeartbeat === 'function' && typeof MON.healthCheck === 'function') {
    try {
      const hc = MON.healthCheck(HOME, cwd, sid);
      MON.logHeartbeat(HOME, { event: 'switch', requested: hc.requested, effective: hc.effective, drift: hc.drift, ok: hc.ok, sensing: true, issues: hc.issues });
    } catch (_) {}
  }

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: (modeLine + senseNote + driftWarn + handoffLine + memLine + reminder).trim() + contractInject }
  });
}

module.exports = run;
if (require.main === module) {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => { let out = ''; try { out = run(data); } catch (_) { out = ''; } if (out) process.stdout.write(out); process.exit(0); });
}
