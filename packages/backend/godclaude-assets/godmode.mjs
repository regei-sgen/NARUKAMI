#!/usr/bin/env node
'use strict';
// godmode.mjs — the GODCLAUDE mode switcher + per-session controller. "Call out the name" to trigger.
//
// MODES (a session may run SEVERAL at once):
//   node godmode.mjs <mode|alias>     switch to a mode (REPLACES the active set; arms the layer)
//   node godmode.mjs add <mode>       ALSO run <mode> alongside the current ones (multi-mode)
//   node godmode.mjs drop <mode>      stop running <mode>
//   node godmode.mjs only <mode>      run exactly <mode> (alias of plain switch)
//   node godmode.mjs modes            list the active mode set for this session
//   node godmode.mjs general          back to the base/general contract (layer stays armed)
//   node godmode.mjs off              make the layer dormant for THIS session (remembers the modes)
//   node godmode.mjs                  show status (armed?/modes/flags/memory) + the available modes
//   node godmode.mjs keywords on|off  enable/disable the in-prompt `godmode:<name>` switch
//   node godmode.mjs autopilot on|off auto-routing: sense each task and switch modes (the SINGLE switch;
//                                     godsense + godsession were merged into autopilot)
//
// COLLABORATION (modes help each other — transparent + opt-in; nothing auto-switches):
//   node godmode.mjs handoff <to> <ctx…>     leave structured context for the NEXT mode (surfaced ONCE
//                                            to that mode when it next runs) | handoff show | handoff clear
//   node godmode.mjs subagent-mode <mode>    spawned SUBAGENTS run under <mode>'s contract + gate (delegate
//                                            a sub-task to another mode; YOUR mode is unchanged) | … off | show
//
// PER-SESSION SHARED MEMORY (isolated to this session; never shared with other sessions):
//   node godmode.mjs mem set <k> <v…> | mem get <k> | mem list | mem del <k> | mem clear | mem path
//
// SESSION STORE admin:
//   node godmode.mjs sessions [list|prune|clear [<id>]]
//
// SCOPING: by default everything targets the CURRENT Claude Code session (env CLAUDE_CODE_SESSION_ID),
// so two sessions never conflict. `--global` targets the legacy global default (seeds new sessions);
// `--session <id>` targets a specific session. Writes ONLY sentinel files under ~/.claude; never edits
// settings.json. Honors DET_HOOKS_HOME (tests).

import fs from 'node:fs';
import os from 'node:os';
import mode from './hooks/godmode-mode.js';     // CJS default import: resolver + alias map (self-guards)
// Per-session store + memory loaded via GUARDED dynamic import — a partial/half-upgraded install (a
// missing core) degrades to a clean message + fail-safe exit, NOT an uncaught ERR_MODULE_NOT_FOUND
// crash. (Static imports can't be try/caught: they resolve before any code runs.)
let STATE, MEM;
try { STATE = (await import('./hooks/godstate-core.js')).default; } catch (_) {}
try { MEM = (await import('./hooks/godmem-core.js')).default; } catch (_) {}
if (!STATE || !MEM) {
  console.error('⚠ GODCLAUDE CLI: a core module (hooks/godstate-core.js or hooks/godmem-core.js) is missing/unreadable —');
  console.error('   likely a partial or half-upgraded install. Reinstall to restore it:  node install.mjs');
  process.exit(0); // fail-safe: never crash with a stack trace (mirrors the hooks' degrade-don't-throw rule)
}

const { ALIASES, PRIMARY, GODNAME, canonicalMode } = mode;
const god = (m) => (GODNAME && GODNAME[m]) ? ` · ${GODNAME[m]}` : ''; // Kami pseudonym decoration (display only)
const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');

// ---- argv parsing (extract flags, leave positional args) ----
const argv = process.argv.slice(2);
function takeOpt(name) { const i = argv.indexOf(name); if (i !== -1) { const v = argv[i + 1] || ''; argv.splice(i, 2); return v; } return ''; }
function takeFlag(name) { const i = argv.indexOf(name); if (i !== -1) { argv.splice(i, 1); return true; } return false; }
const forceGlobal = takeFlag('--global');
const sessionOpt = takeOpt('--session');
const scopeArg = (takeOpt('--scope') || '').trim().toLowerCase();
const validScope = (scopeArg === 'session' || scopeArg === 'prompt') ? scopeArg : '';
// `--session <id>` must be a real session id, NOT a mode or subcommand token (which it would otherwise
// greedily swallow, leaving the CLI to silently fall through to `status`). Reject those with guidance.
const RESERVED = new Set(['on', 'off', 'status', 'add', 'drop', 'only', 'modes', 'general', 'mem', 'memory', 'sessions', 'keywords', 'sense', 'session', 'dormant',
  // WP-2.4: also reserve the remaining subcommand words so `--session autopilot`/`--session handoff` etc.
  // can't be mistaken for a session id (which would create a phantom overlay dir named after the subcommand).
  'autopilot', 'godpilot', 'handoff', 'subagent', 'subagentmode', 'subagent-mode', 'prune', 'clear', 'show']);
// Reject a mode, a reserved subcommand, OR any dash-prefixed token (a flag/alias like --off/-s the
// user fat-fingered after --session) — a real Claude session id is a UUID and never starts with '-'.
if (sessionOpt && (canonicalMode(sessionOpt) || RESERVED.has(sessionOpt.toLowerCase()) || sessionOpt.startsWith('-'))) {
  console.error(`⚠ --session needs a session ID, not "${sessionOpt}". To switch modes use:  node godmode.mjs ${canonicalMode(sessionOpt) ? sessionOpt : '<mode>'}`);
  process.exit(1);
}
// WP-2.4: an EXPLICITLY-targeted `--session <id>` that isn't a valid session id must HARD-ERROR, never
// silently retarget to the env session or the global default. `autopilot off --session "5f3a/bad"` used to
// fall through to STATE.envSid()/global and could delete the GLOBAL autopilot sentinel — a destructive
// silent misfire. sanitizeSid rejects '/', whitespace, and >128-char tokens.
if (sessionOpt && !STATE.sanitizeSid(sessionOpt)) {
  console.error(`⚠ --session id "${sessionOpt}" is not a valid session id (no '/', '\\', ':', spaces; ≤128 chars). Refusing to run — an invalid id must never silently retarget the global default or another session.`);
  process.exit(1);
}
// The session this invocation targets: --global => global; --session <id> => that; else this session.
const SID = forceGlobal ? '' : (STATE.sanitizeSid(sessionOpt) || STATE.envSid());
const SCOPE_LABEL = SID ? `session ${SID.slice(0, 8)}` : 'global default';
// Did the user EXPLICITLY target a session with `--session <id>`? (vs. inheriting the env session.)
// Used so `autopilot --session <id>` opts ONE session in/out instead of silently changing the global.
const explicitSession = !forceGlobal && !!STATE.sanitizeSid(sessionOpt);

const arg = (argv[0] || '').trim();
const arg2 = (argv[1] || '').trim().toLowerCase();
const a = arg.toLowerCase();

// ---- state helpers (all session-overlay-aware) ----
function isArmed() { const e = process.env.GODMODE_ACTIVE; if (e === '1') return true; if (e === '0') return false; return STATE.armed(HOME, SID); }
// AUTO-PILOT is the single auto-routing switch (godsense/godsession were merged into it).
function autopilotOn() { return STATE.flagOn(HOME, SID, 'autosession'); }
// GLOBAL auto-pilot (the user-wide default), independent of any per-session overlay.
function globalAutopilotOn() { return STATE.flagOn(HOME, '', 'autosession'); }
// Full per-session opt-OUT of auto-routing: overlay the autopilot flag OFF, so this session stops
// auto-routing even while the GLOBAL auto-pilot default stays on for other sessions (flagOn honors the
// overlay over the global file). Used by `autopilot off --session <id>`.
function optOutSession() {
  STATE.writeState(HOME, SID, 'autosession', 'off\n');
}
function keywordsOn() { return STATE.flagOn(HOME, SID, 'keywords'); }
// The currently-selected CANONICAL mode names (raw overlay/global lines), independent of whether the
// modes/ dir is readable. Set operations (add/drop/only) use THIS so editing never depends on disk
// state — the resolver validates against installed folders at hook time. generals dropped, de-duped.
function currentRawModes() {
  const out = [];
  for (const x of STATE.requestedModeList(HOME, SID)) { const c = canonicalMode(x) || String(x || '').toLowerCase(); if (c && c !== 'general' && !out.includes(c)) out.push(c); }
  return out;
}
function godsiteScope() { return STATE.requestedModeList(HOME, SID).includes('web-builder') ? (STATE.readState(HOME, SID, 'godsite-scope') || '').split('\n').map(l => l.trim()).find(Boolean) || '' : ''; }
function ensureArmed() { if (!isArmed()) STATE.writeState(HOME, SID, 'active', 'enabled\n'); }

function label(m) { return m === 'general' ? `general${god('general')} (base godclaude)` : `${m}${god(m)} (${PRIMARY[m] || m})`; }
function modesLabel(list) { const r = (list || []).filter(m => m && m !== 'general'); return r.length ? r.join(' + ') : 'general'; }

// WP-2.4: parse an on/off toggle argument STRICTLY → 'on' | 'off' | null. An UNKNOWN word returns null so
// the caller can error out — previously anything not in a small off-list (e.g. `autopilot disabled`) fell
// through to the ON branch and silently ARMED the layer. Empty = 'on' (a bare `autopilot`/`keywords` enables).
// Off-words are shared with the store's own reader (STATE.OFF_WORDS) so CLI and store can never drift.
const ON_WORDS = new Set(['on', 'true', '1', 'enable', 'enabled', 'yes']);
function parseToggle(val) {
  const v = String(val == null ? '' : val).trim().toLowerCase();
  if (v === '' || ON_WORDS.has(v)) return 'on';
  if ((STATE.OFF_WORDS && STATE.OFF_WORDS.has(v)) || v === 'stop') return 'off';
  return null;
}

// Refuse selecting a PATH-GATED mode from outside its scope (it would persist a dead selection).
function refuseIfOutsideScope(m) {
  let scope = [];
  try { if (m !== 'general') scope = mode.loadModeScope(HOME, m) || []; } catch (_) {}
  if (!scope.length) return false;
  let inside = false; try { inside = mode.withinScope(process.cwd(), scope); } catch (_) {}
  if (inside) return false;
  console.error(`⛔ ${label(m)} is PATH-GATED — it only activates inside:`);
  for (const p of scope) console.error(`     ${p}`);
  console.error(`   You're in: ${process.cwd().replace(/\\/g, '/')}`);
  console.error(`   cd into that directory and run this there once; then it AUTO-activates whenever you work inside it.`);
  return true;
}

// Persist the active mode SET (ordered list). Pins (explicit) unless pin=false; arms the layer.
// Records/clears godsite run-scope when web-builder is in/out of the set.
// WP-2.4: returns whether the MODE sentinel was actually persisted. STATE.writeState returns '' on failure
// (e.g. ~/.claude unwritable). Callers MUST check and exit 1 on falsy — printing "✅ mode: developer" and
// exiting 0 while nothing was written is exactly the unverified-success lie this whole layer exists to stop.
function writeModes(list, { pin = true } = {}) {
  const clean = [];
  for (const m of list) { if (m && m !== 'general' && !clean.includes(m)) clean.push(m); }
  const wrote = STATE.writeState(HOME, SID, 'mode', (clean.length ? clean.join('\n') : 'general') + '\n');
  if (pin) STATE.writeState(HOME, SID, 'explicit', 'explicit\n');
  else STATE.clearState(HOME, SID, 'explicit', SID ? 'session' : 'global');
  // godsite scope: keep only while web-builder is active.
  if (clean.includes('web-builder') && validScope) STATE.writeState(HOME, SID, 'godsite-scope', validScope + '\n');
  else if (!clean.includes('web-builder')) STATE.clearState(HOME, SID, 'godsite-scope', SID ? 'session' : 'global');
  ensureArmed();
  return !!wrote;
}
// Shared failure exit for a mode-state write that didn't land (fail closed, loud — matches handoff/subagent-mode).
function failWrite() {
  console.error(`⚠ could not write mode state to ${SCOPE_LABEL} (is ~/.claude writable?). Nothing was changed — the layer's state is unchanged.`);
  process.exit(1);
}

function showStatus() {
  const modes = currentRawModes();
  const gsScope = godsiteScope();
  const gsSeg = gsScope ? ` | godsite-scope: ${gsScope === 'prompt' ? 'prompt-only' : gsScope}` : '';
  const saMode = (() => { try { return (STATE.readState(HOME, SID, 'subagent-mode') || '').trim(); } catch (_) { return ''; } })();
  const saSeg = saMode ? ` | subagent-mode: ${PRIMARY[saMode] || saMode}` : '';
  const memN = (() => { try { return MEM.memCount(HOME, SID); } catch (_) { return 0; } })();
  console.log(`GODCLAUDE [${SCOPE_LABEL}]: ${isArmed() ? 'ARMED' : 'dormant'} | modes: ${modesLabel(modes)} | autopilot: ${autopilotOn() ? 'ON' : 'off'} | keywords: ${keywordsOn() ? 'on' : 'off'} | shared-memory: ${memN} item${memN === 1 ? '' : 's'}${gsSeg}${saSeg}`);
  if (autopilotOn()) console.log(`Auto-pilot ON: senses each task and switches modes (active every session; god modes preferred, normal Claude only for easy prompts). Off: node ~/.claude/godmode.mjs autopilot off`);
  if (saMode) console.log(`subagent-mode ${PRIMARY[saMode] || saMode}: ALL subagents you spawn run under its contract + proof gate until cleared — node ~/.claude/godmode.mjs subagent-mode off`);
  { let ph = null; try { ph = JSON.parse(STATE.readState(HOME, SID, 'handoff') || ''); } catch (_) {} if (ph && ph.to) console.log(`Pending handoff → ${PRIMARY[ph.to] || ph.to} (from ${PRIMARY[ph.from] || ph.from || 'general'})${ph.context ? ` — ${ph.context}` : ''}; surfaces ONCE when that mode next runs. Clear: node ~/.claude/godmode.mjs handoff clear`); }
  if (SID) console.log(`Isolation: this session's modes + memory are private to it; other sessions are unaffected. (--global targets the seed default.)`);
  console.log('Available: ' + Object.keys(PRIMARY).map(m => {
    let scoped = false; try { scoped = (mode.loadModeScope(HOME, m) || []).length > 0; } catch (_) {}
    return `${m} [${PRIMARY[m]}${GODNAME && GODNAME[m] ? ` · ${GODNAME[m]}` : ''}]${scoped ? ' (path-gated)' : ''}`;
  }).join(', ') + `, general${GODNAME && GODNAME.general ? ` [${GODNAME.general}]` : ''}`);
  console.log('Switch: node ~/.claude/godmode.mjs <mode>  |  add: ... add <mode>  |  dormant: ... off');
}

// ===================== command dispatch =====================
if (!arg || a === 'status' || a === '--status' || a === '-s') { showStatus(); process.exit(0); }

// ---- per-session shared memory ----
if (a === 'mem' || a === '--mem' || a === 'memory') {
  const sub = arg2;
  const where = SID ? `session ${SID.slice(0, 8)}` : 'global (no session)';
  if (sub === 'set') {
    const key = argv[2] || ''; const val = argv.slice(3).join(' ');
    if (!key) { console.error('Usage: mem set <key> <value…>'); process.exit(1); }
    const ok = MEM.memSet(HOME, SID, key, val);
    console.log(ok ? `✅ [${where}] remembered ${MEM.cleanKey(key)} = ${val}` : `⚠ could not write memory`);
  } else if (sub === 'get') {
    const v = MEM.memGet(HOME, SID, argv[2] || '');
    if (v == null) { console.error(`(no value for "${argv[2] || ''}")`); process.exit(1); }
    console.log(v);
  } else if (sub === 'del' || sub === 'delete' || sub === 'rm') {
    console.log(MEM.memDel(HOME, SID, argv[2] || '') ? `✅ deleted ${MEM.cleanKey(argv[2] || '')}` : `(no such key)`);
  } else if (sub === 'clear') {
    MEM.memClear(HOME, SID); console.log(`✅ [${where}] shared memory cleared`);
  } else if (sub === 'path') {
    console.log(MEM.memFile(HOME, SID));
  } else { // list (default)
    const items = MEM.memList(HOME, SID);
    console.log(`Shared memory [${where}] — ${items.length} item${items.length === 1 ? '' : 's'}${SID ? ' (isolated to this session)' : ' (global fallback — no active session)'}:`);
    for (const it of items) console.log(`  ${it.key} = ${it.value}`);
    if (!items.length) console.log('  (empty)  set one: node ~/.claude/godmode.mjs mem set <key> <value>');
  }
  process.exit(0);
}

// ---- handoff: leave structured context for the NEXT mode (transparent collaboration; never auto-switches) ----
// `handoff <to-mode> <context…>` records a one-shot note that the per-turn hook surfaces to that mode the
// first time it becomes active, then clears. `handoff clear` / `handoff show` manage it. Stored in a
// dedicated session overlay key (NOT shared memory) so it doesn't pollute the memory digest.
if (a === 'handoff' || a === '--handoff') {
  // Where the EFFECTIVE handoff physically lives: the session overlay shadows the global file, and
  // readState falls back overlay->global. clear/show must act on the ACTUAL location (clearing with a
  // fixed 'session' scope can't remove a global handoff — it would falsely report success).
  const handoffScope = () => {
    try { const sp = STATE.sessionPath(HOME, SID, 'handoff'); if (sp && fs.existsSync(sp)) return 'session'; } catch (_) {}
    try { if (fs.existsSync(STATE.globalPath(HOME, 'handoff'))) return 'global'; } catch (_) {}
    return '';
  };
  if (arg2 === 'clear' || arg2 === 'off') {
    const sc = handoffScope();
    if (!sc) { console.log(`No pending handoff to clear [${SCOPE_LABEL}].`); process.exit(0); }
    STATE.clearState(HOME, SID, 'handoff', sc);
    console.log(`✅ handoff cleared [${sc === 'global' ? 'global default' : SCOPE_LABEL}].`);
    process.exit(0);
  }
  if (arg2 === 'show' || arg2 === 'status') {
    const sc = handoffScope();
    const raw = STATE.readState(HOME, SID, 'handoff') || '';
    let h = null; try { h = JSON.parse(raw); } catch (_) {}
    const lbl = sc === 'global' ? 'global default' : SCOPE_LABEL;
    if (h) console.log(`Pending handoff [${lbl}]: → ${PRIMARY[h.to] || h.to} (from ${PRIMARY[h.from] || h.from || 'general'}): ${h.context || '(no context)'}`);
    else if (raw.trim()) console.log(`⚠ Corrupt handoff note [${lbl}] — clear it: node ~/.claude/godmode.mjs handoff clear`);
    else console.log(`No pending handoff [${SCOPE_LABEL}].`);
    process.exit(0);
  }
  const to = canonicalMode(arg2);
  if (!to || to === 'general') {
    console.error(`Usage: handoff <mode> <context…>  (e.g. handoff godqa "added refund path, needs edge-case tests"). Modes: ${Object.keys(PRIMARY).join(', ')}. Also: handoff show | handoff clear.`);
    process.exit(1);
  }
  const context = argv.slice(2).join(' ').trim();
  const from = currentRawModes()[0] || 'general';
  const ok = STATE.writeState(HOME, SID, 'handoff', JSON.stringify({ from, to, context }) + '\n');
  if (ok) {
    console.log(`✅ Handoff queued [${SCOPE_LABEL}]: ${PRIMARY[from] || from} → ${PRIMARY[to] || to}${context ? ` — ${context}` : ''}`);
    console.log(`It surfaces ONCE to ${PRIMARY[to] || to} the next time that mode is active (switch with: node ~/.claude/godmode.mjs ${to}). Nothing auto-switches.`);
  } else { console.error('⚠ could not write the handoff note.'); process.exit(1); }
  process.exit(0);
}

// ---- subagent-mode: run subagents you spawn under a DIFFERENT mode (delegate a sub-task to another
// mode's discipline; your own session mode is unchanged). Stored in a dedicated overlay key, honored by
// the SubagentStart contract injector + the SubagentStop gate. Applies to ALL subagents until cleared. ----
if (a === 'subagent-mode' || a === 'subagentmode' || a === '--subagent-mode' || a === 'subagent') {
  if (['off', 'clear', 'none', 'false', '0'].includes(arg2)) {
    STATE.clearState(HOME, SID, 'subagent-mode', SID ? 'session' : 'global');
    console.log(`✅ subagent-mode cleared [${SCOPE_LABEL}] — subagents now inherit this session's active mode again.`);
    process.exit(0);
  }
  if (arg2 === 'show' || arg2 === 'status' || !arg2) {
    const cur = (STATE.readState(HOME, SID, 'subagent-mode') || '').trim();
    console.log(cur ? `subagent-mode [${SCOPE_LABEL}]: ${PRIMARY[cur] || cur} — subagents you spawn run under its contract + proof gate.` : `subagent-mode [${SCOPE_LABEL}]: off — subagents inherit this session's active mode.`);
    process.exit(0);
  }
  const sm = canonicalMode(arg2);
  if (!sm || sm === 'general') {
    console.error(`Usage: subagent-mode <mode> | off | show  (e.g. subagent-mode godqa). Modes: ${Object.keys(PRIMARY).join(', ')}.`);
    process.exit(1);
  }
  if (refuseIfOutsideScope(sm)) process.exit(1);
  const ok = STATE.writeState(HOME, SID, 'subagent-mode', sm + '\n');
  if (ok) {
    ensureArmed();
    console.log(`✅ subagent-mode [${SCOPE_LABEL}]: ${PRIMARY[sm] || sm} — subagents you spawn now run under ${PRIMARY[sm] || sm}'s contract + proof gate; YOUR mode is unchanged.`);
    console.log(`Delegate the sub-task, then clear: node ~/.claude/godmode.mjs subagent-mode off.  (Applies to ALL subagents in this session until cleared.)`);
  } else { console.error('⚠ could not set subagent-mode.'); process.exit(1); }
  process.exit(0);
}

// ---- session store admin ----
if (a === 'sessions' || a === '--sessions') {
  const sub = arg2;
  if (sub === 'prune') {
    const n = STATE.gcSessions(HOME, { keepSid: SID });
    console.log(`✅ pruned ${n} stale session overlay${n === 1 ? '' : 's'} (older than 14 days / over the cap).`);
  } else if (sub === 'clear') {
    const target = argv[2] || '';
    if (target) { console.log(STATE.removeSession(HOME, target) ? `✅ cleared session ${target}` : `(no such session ${target})`); }
    else { let n = 0; for (const s of STATE.listSessions(HOME)) { if (STATE.removeSession(HOME, s)) n++; } console.log(`✅ cleared ${n} session overlay${n === 1 ? '' : 's'}.`); }
  } else { // list
    const ids = STATE.listSessions(HOME);
    console.log(`Session overlays — ${ids.length}:`);
    for (const s of ids) {
      const m = modesLabel(mode.requestedFolders(HOME, s));
      const memN = (() => { try { return MEM.memCount(HOME, s); } catch (_) { return 0; } })();
      console.log(`  ${s === SID ? '*' : ' '} ${s.slice(0, 12)}…  modes: ${m}  mem: ${memN}`);
    }
    if (!ids.length) console.log('  (none yet)');
  }
  process.exit(0);
}

// ---- off (dormant) ----
if (['off', '--off', 'dormant', '--dormant'].includes(a)) {
  if (SID) { STATE.writeState(HOME, SID, 'active', 'off\n'); STATE.clearState(HOME, SID, 'explicit', 'session'); }
  else { STATE.clearState(HOME, '', 'active', 'global'); STATE.clearState(HOME, '', 'explicit', 'global'); }
  const modes = currentRawModes();
  console.log(`GODCLAUDE dormant for ${SCOPE_LABEL}. Remembered modes: ${modesLabel(modes)}. Re-arm: node ~/.claude/godmode.mjs ${modes[0] || 'goddev'}`);
  process.exit(0);
}

// ---- flag toggles (keywords / sense / session) ----
function setFlag(name, on) {
  if (on) STATE.writeState(HOME, SID, name, 'enabled\n');
  else if (SID) STATE.writeState(HOME, SID, name, 'off\n'); // overlay OFF overrides a global default-on
  else STATE.clearState(HOME, '', name, 'global');
}
if (a === 'keywords' || a === '--keywords') {
  const t = parseToggle(arg2);
  if (t === null) { console.error(`⚠ keywords: unknown argument "${arg2}". Use: keywords on | off.`); process.exit(1); }
  if (t === 'off') { setFlag('keywords', false); console.log(`In-prompt keyword switching DISABLED [${SCOPE_LABEL}].`); }
  else { setFlag('keywords', true); console.log(`In-prompt keyword switching ENABLED [${SCOPE_LABEL}]. Type \`godmode:<mode>\` in a prompt to switch.`); }
  process.exit(0);
}
// NOTE: the old `sense` and `session` subcommands (godsense / godsession) were REMOVED — they were
// redundant sub-toggles of the same auto-router. `autopilot` (below) is now the SINGLE auto-routing
// switch. (`--session <id>` is unrelated: it is the session-SCOPING flag, still parsed above.)

// ---- AUTO-PILOT: the single auto-routing switch. Active immediately every session + AGGRESSIVE routing
// (senses each task; god modes most of the time, normal Claude only for easy prompts). A GLOBAL,
// user-wide default — but `--session <id>` opts ONE session in/out (overlay) without changing the global
// default for everyone. ----
function setAutopilot(val, perSession) {
  const t = parseToggle(val);
  if (t === null) { console.error(`⚠ autopilot: unknown argument "${val}". Use: autopilot on | off  (one session: autopilot off --session <id>).`); process.exit(1); }
  const off = t === 'off';
  if (perSession && SID) { // per-session overlay: opt THIS session in/out, leave the global default alone
    if (off) {
      optOutSession(); // autosession overlay = off
      console.log(`Auto-pilot OFF for session ${SID.slice(0, 8)} only (overlay) — this session stops auto-routing; the GLOBAL default stays ON for other sessions.`);
    } else {
      STATE.writeState(HOME, SID, 'autosession', 'enabled\n');
      STATE.clearState(HOME, SID, 'explicit', 'session'); ensureArmed();
      console.log(`Auto-pilot ON for session ${SID.slice(0, 8)} only (overlay).`);
    }
    return;
  }
  if (off) {
    STATE.clearState(HOME, '', 'autosession', 'global');
    console.log('Auto-pilot OFF (global). New sessions no longer auto-activate aggressive routing — modes change only when you select them (or via the godmode: keyword).');
    console.log('(Opt a SINGLE session out instead — keeping the global default — with: node ~/.claude/godmode.mjs autopilot off --session <id>.)');
  } else {
    STATE.writeState(HOME, '', 'autosession', 'enabled\n'); // global preference: aggressive auto-routing
    STATE.writeState(HOME, '', 'active', 'enabled\n');        // arm the layer globally
    console.log('✅ Auto-pilot ON (global default for ALL Claude sessions) — the single auto-routing switch:');
    console.log('   • Auto-routing activates IMMEDIATELY when you open a session (announced at session start).');
    console.log('   • Each task is sensed and the matching GOD MODE switched in; normal Claude only for easy prompts.');
    console.log('   • A confident signal switches mode even mid-session; an ambiguous follow-up keeps the current mode.');
    console.log('   • Every switch is announced and names the active mode. An explicit `node ~/.claude/godmode.mjs <mode>` pins it.');
    console.log('   Turn off:  node ~/.claude/godmode.mjs autopilot off   (one session: autopilot off --session <id>)');
  }
}
if (a === 'autopilot' || a === '--autopilot' || a === 'godpilot') { setAutopilot(arg2 || 'on', explicitSession); process.exit(0); }

// ---- multi-mode set ops: add / drop / only / modes ----
if (a === 'modes' || a === '--modes') {
  const m = currentRawModes();
  console.log(`Active modes [${SCOPE_LABEL}]: ${modesLabel(m)}${m.length > 1 ? '  (all enforced together)' : ''}`);
  process.exit(0);
}
if (a === 'add' || a === 'drop' || a === 'only') {
  const m = canonicalMode(arg2 || argv[1] || '');
  if (!m || m === 'general') {
    console.error(`Usage: ${a} <mode>  (e.g. ${a} godqa). Modes: ${Object.keys(PRIMARY).join(', ')}.`);
    process.exit(1);
  }
  if (refuseIfOutsideScope(m)) process.exit(1);
  let cur = currentRawModes();
  if (a === 'only') cur = [m];
  else if (a === 'add') { if (!cur.includes(m)) cur.push(m); }
  else if (a === 'drop') cur = cur.filter(x => x !== m);
  // Dropping the LAST mode leaves an empty set => general. Treat that like the explicit `general`
  // command: UN-pin (pin only when modes remain), so autopilot routing can resume — otherwise the leftover
  // `explicit` pin would silently freeze auto-routing. add/only never empty the set, so they keep pin.
  if (!writeModes(cur, { pin: cur.length > 0 })) failWrite();
  const now = currentRawModes();
  console.log(`✅ GODCLAUDE modes [${SCOPE_LABEL}]: ${modesLabel(now)}  [layer ${isArmed() ? 'ARMED' : 'dormant'}]`);
  if (now.length > 1) console.log(`Running ${now.length} modes together — the gate enforces the UNION of their proof rules (strictest re-read rule wins).`);
  console.log('Gate + per-turn reminder apply on your NEXT turn. Full contract injects on a NEW session.');
  process.exit(0);
}

// ---- plain mode switch (REPLACE) / general ----
const m = canonicalMode(arg);
if (!m) {
  console.error(`Unknown mode "${arg}". Available: ${Object.keys(PRIMARY).join(', ')}, general.`);
  console.error('Aliases: ' + Object.entries(ALIASES).map(([k, v]) => `${k} <= ${v.join('/')}`).join(' ; '));
  console.error('Multi-mode: `add <mode>` to run several at once. Memory: `mem set/get/list`. Sessions: `sessions`.');
  process.exit(1);
}
if (m === 'general') {
  if (!STATE.writeState(HOME, SID, 'mode', 'general\n')) failWrite();
  STATE.clearState(HOME, SID, 'explicit', SID ? 'session' : 'global');
  STATE.clearState(HOME, SID, 'godsite-scope', SID ? 'session' : 'global');
  ensureArmed();
  console.log(`✅ GODCLAUDE mode: ${label('general')} [${SCOPE_LABEL}, layer ${isArmed() ? 'ARMED' : 'dormant'}]`);
  process.exit(0);
}
if (refuseIfOutsideScope(m)) process.exit(1);
if (!writeModes([m], { pin: true })) failWrite();   // plain select REPLACES the active set
let scope = []; try { scope = mode.loadModeScope(HOME, m) || []; } catch (_) {}
console.log(`✅ GODCLAUDE mode: ${label(m)}  [${SCOPE_LABEL}, layer ${isArmed() ? 'ARMED' : 'NOT armed'}]`);
if (scope.length) console.log(`Note: ${label(m)} is PATH-GATED — it auto-activates only inside ${scope.join(', ')} and is OFF elsewhere.`);
if (m === 'web-builder' && validScope) console.log(`Scope: ${validScope === 'prompt' ? 'prompt-only — intended for this one request; run "node ~/.claude/godmode.mjs general" to deactivate when done (no hook auto-clears it)' : 'session — stays active until you turn godsite off'}.`);
console.log('Run several at once: node ~/.claude/godmode.mjs add <mode>. Per-session memory: mem set/get/list.');
console.log('Gate + per-turn reminder switch on your NEXT turn. The full long-form contract injects on a NEW session (SessionStart).');
