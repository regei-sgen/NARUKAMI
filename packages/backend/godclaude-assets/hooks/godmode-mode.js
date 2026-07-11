#!/usr/bin/env node
'use strict';
// godmode-mode.js — shared MODE resolver for the GODCLAUDE deterministic layer.
//
// Single source of truth for: which mode is active, where a mode's assets live, and the
// alias map ("call out the name" -> canonical folder). CommonJS on purpose so the CJS hook
// scripts (inject-*.js, block-unverified-completion.js) can `require('./godmode-mode.js')`.
// The ESM CLI (godmode.mjs) imports it via a default import.
//
// FAIL-SAFE: anything missing / unreadable / unknown => 'general' (today's behavior). Never throws.
// The base contract (~/.claude/deterministic-contract.md) + the gate's base pattern sets ARE the
// 'general' mode, so an install with no modes/ dir behaves EXACTLY as before this file existed.
//
// Active-mode precedence:
//   1. env GODMODE_MODE        ('' or 'general' => general; otherwise validated, unknown => general)
//   2. first non-empty line of <home>/.claude/godmode-mode
//   3. 'general'
//
// Honors DET_HOOKS_HOME (sandbox/tests) the same way the gate + wrapper do.
// GODMODE_MODES_DIR overrides the modes root (test seam: lets the suite point at the source
// assets/modes without an install). Unset in normal use => <home>/.claude/modes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Per-session state store (overlay -> global). Guarded: if it's missing (partial install), fall back
// to a GLOBAL-ONLY shim so the resolver behaves byte-for-byte as it did before sessions existed.
let STATE;
try { STATE = require('./godstate-core.js'); }
catch (_) {
  const GF = { mode: 'godmode-mode', active: 'godmode-active', explicit: 'godmode-explicit', keywords: 'godmode-keywords', 'godsite-scope': 'godsite-scope' };
  const gp = (home, name) => `${home}/.claude/${GF[name] || name}`;
  STATE = {
    sessionPath: () => '', globalPath: gp, modeOverlayActive: () => false,
    requestedModeList(home, _sid) {
      const env = (process.env.GODMODE_MODE || '').trim(); if (env) return [env];
      try { const t = fs.readFileSync(gp(home, 'mode'), 'utf8'); const v = (t.split('\n').map(l => l.trim()).find(Boolean) || ''); return v ? [v] : []; } catch (_) { return []; }
    },
    requestedModePrimary(home, sid) { return this.requestedModeList(home, sid)[0] || ''; },
  };
}
function _exists(p) { try { return !!p && fs.existsSync(p); } catch (_) { return false; } }

// trigger word(s) you "call out" -> canonical mode folder name.
// MERGE NOTE: debugger (godbug) and ui-ux (godpixel) were FOLDED INTO developer (goddev). Their old
// trigger words live on as developer aliases (so /godbug, /godpixel, debug/ui/ux still work — they now
// switch to the merged developer mode, which carries all three proof standards). There is no longer a
// standalone `debugger` or `ui-ux` mode folder; a legacy `godmode-mode` file holding either string still
// resolves to developer via validateFolder -> canonicalMode. See modes/developer/contract.md.
const ALIASES = {
  developer:      ['goddev', 'godcode', 'godbuild', 'dev', 'developer',
                   'godbug', 'gbug', 'godebug', 'rootcause', 'debug', 'debugger',   // merged: debugger
                   'godpixel', 'godux', 'godeye', 'uiux', 'ui', 'ux', 'ui-ux',      // merged: ui-ux
                   'mahitotsu'],                                                   // Kami pseudonym
  researcher:     ['godscout', 'godsource', 'godcite', 'scout', 'research', 'researcher', 'kuebiko'],
  'data-analyst': ['goddata', 'godquery', 'goddf', 'godstat', 'data', 'analyst', 'data-analyst', 'tsukuyomi'],
  qa:             ['godqa', 'godtest', 'gqa', 'qa', 'enma'],
  reviewer:       ['godreview', 'godaudit', 'godcr', 'review', 'reviewer', 'audit', 'auditor', 'susanoo'],
  planner:        ['godplan', 'godarch', 'goddesign', 'plan', 'planner', 'architect', 'omoikane'],
  'ci-cd':        ['godship', 'godpipe', 'godeploy', 'cicd', 'cd', 'ci-cd', 'sarutahiko'],
  'web-builder':  ['godsite', 'godweb', 'godpage', 'uzume'],
};
// the primary trigger word shown to users, per canonical mode.
const PRIMARY = {
  developer: 'goddev', researcher: 'godscout', 'data-analyst': 'goddata',
  qa: 'godqa', reviewer: 'godreview', planner: 'godplan', 'ci-cd': 'godship',
  'web-builder': 'godsite',
};
// Kami pseudonyms (Part B) — a DISPLAY layer, keyed by canonical id. Never a functional identifier:
// state files, log tokens, dir names, and the banner head all keep the canonical id; these decorate CLI /
// dashboard / contract output only. 'general' → Amaterasu (the base, oversees all). Consumed via GODNAME[id].
const GODNAME = {
  developer: 'Mahitotsu', researcher: 'Kuebiko', 'data-analyst': 'Tsukuyomi', qa: 'Enma',
  reviewer: 'Susanoo', planner: 'Omoikane', 'ci-cd': 'Sarutahiko', 'web-builder': 'Uzume', general: 'Amaterasu',
};
// Natural relationships between modes — the SINGLE SOURCE OF TRUTH for "what's next" handoff guidance
// (surfaced as a "Works with / hand off to" line in each mode's contract). `next` = the mode you'd
// typically move TO when this mode's work is done; `pairs` = modes that run WELL alongside this one (via
// multi-mode `add`). SUGGESTIONS ONLY — nothing here auto-switches; the agent/user always chooses the
// switch (the layer stays deterministic + opt-in + no-silent-action). Keys are canonical mode names.
const HANDOFFS = {
  planner:        { next: ['developer'],                 pairs: ['researcher'] },
  developer:      { next: ['qa', 'reviewer', 'ci-cd'],   pairs: ['researcher', 'data-analyst'] },
  qa:             { next: ['reviewer', 'developer'],      pairs: ['developer'] },
  reviewer:       { next: ['developer', 'ci-cd'],         pairs: ['qa'] },
  'ci-cd':        { next: ['developer', 'qa'],            pairs: ['reviewer'] },
  researcher:     { next: ['developer', 'planner'],       pairs: ['developer', 'planner', 'data-analyst'] },
  'data-analyst': { next: ['developer', 'planner'],       pairs: ['researcher'] },
  'web-builder':  { next: ['ci-cd'],                      pairs: [] },
};
// Handoff entry for a mode (canonical or alias), or null. Suggestions only.
function handoffsFor(mode) {
  const m = canonicalMode(mode);
  return (m && m !== 'general' && Object.prototype.hasOwnProperty.call(HANDOFFS, m)) ? HANDOFFS[m] : null;
}
// Generated "Works with / hand off to" markdown block for a mode, derived from HANDOFFS (single source,
// so every mode's handoff guidance stays in sync automatically). Appended to the injected contract at
// SessionStart and on a mid-session switch — NEVER auto-acts; it only tells the agent where it could go
// next. '' for general/unknown or a mode with no relationships. `trig` maps canonical → its /trigger.
function handoffGuidance(mode) {
  const h = handoffsFor(mode);
  if (!h) return '';
  const trig = (m) => '/' + (PRIMARY[m] || m);
  const next = (Array.isArray(h.next) ? h.next : []).filter(Boolean);
  const pairs = (Array.isArray(h.pairs) ? h.pairs : []).filter(Boolean);
  if (!next.length && !pairs.length) return '';
  let s = '\n\n## Works with / hand off to (suggestions — you/the user choose; NEVER automatic)\n';
  if (next.length) s += `- When this mode's work is done, the natural next step is usually: ${next.map(trig).join(', ')}.\n`;
  if (pairs.length) s += `- Runs well ALONGSIDE (multi-mode \`add\`): ${pairs.map(trig).join(', ')}.\n`;
  s += '- Pointers only — switch with `node ~/.claude/godmode.mjs <mode>` (or the `/<trigger>` skill); leave structured context for the next mode with `node ~/.claude/godmode.mjs handoff <mode> <context>`. Nothing here auto-switches.';
  return s;
}

function homeDir() {
  return (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
}
function modesRoot(home) {
  const h = home || homeDir();
  return (process.env.GODMODE_MODES_DIR || `${h}/.claude/modes`).replace(/\\/g, '/');
}
function modeDir(home, mode) {
  return `${modesRoot(home)}/${mode}`;
}
function listModes(home) {
  try {
    return fs.readdirSync(modesRoot(home), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (_) { return []; }
}
// Map any alias / trigger word / canonical name to its canonical mode folder. '' if unknown.
// 'general' is passed through (it is a valid pseudo-mode = the base contract).
function canonicalMode(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  if (s === 'general' || s === 'amaterasu') return 'general'; // 'general' has no ALIASES entry; amaterasu is its Kami pseudonym
  // hasOwnProperty (not `ALIASES[s]`) so prototype keys like 'constructor'/'__proto__' don't leak
  // through as "valid" modes.
  if (Object.prototype.hasOwnProperty.call(ALIASES, s)) return s;
  for (const [mode, aliases] of Object.entries(ALIASES)) if (aliases.includes(s)) return mode;
  return '';
}
// The RAW, UNVALIDATED mode the user asked for: env GODMODE_MODE, else the session overlay's `mode`
// (its first line), else the global godmode-mode file. '' if none. This is the "intended" mode —
// godmonitor compares it to resolveMode() to detect a lost path (drift). Optional `sid` engages the
// per-session overlay; omit it (legacy callers) and it reads env -> global exactly as before.
function requestedMode(home, sid) {
  return STATE.requestedModePrimary(home || homeDir(), sid || '');
}
// The FULL ordered list of requested modes (multi-mode): env -> session overlay (one per line) ->
// global (single line). [] if none. Primary = [0].
function requestedModesRaw(home, sid) {
  return STATE.requestedModeList(home || homeDir(), sid || '');
}
// ---- PATH-GATING (scoped modes) --------------------------------------------------------------
// A mode is "scoped" (path-gated) when its folder ships a scope.json: { "paths": [dir, ...] }.
// Such a mode AUTO-ACTIVATES only when the session cwd is one of those dirs (or a descendant) and is
// fully OFF (resolves to 'general') everywhere else — a binary, directory-gated layer (isolated, not
// covert: the scope is declared in scope.json and godmonitor reports it when active). The
// machinery is generic/data-driven: any mode folder with a scope.json gets gated; the built-in modes
// ship none, so they are unaffected. cwd is the hook payload's `cwd` field, threaded in by callers.
function normPath(p) {
  if (typeof p !== 'string' || !p.trim()) return '';               // empty/invalid => '' (NOT process.cwd())
  // path.resolve CANONICALIZES the path: it resolves '..'/'.' segments — so a traversal cwd like
  // '<scope>/../sibling' can no longer string-prefix-match its way back "inside" the scope — and it
  // collapses duplicate separators and makes relative paths absolute. Guarded: on any failure fall
  // back to the raw string so a weird input can never throw (the layer must stay fail-safe).
  let s;
  try { s = path.resolve(p); } catch (_) { s = p; }
  s = s.replace(/\\/g, '/').replace(/\/+$/, '');                   // backslashes -> '/', drop trailing '/'
  if (process.platform === 'win32') s = s.toLowerCase();          // Windows paths are case-insensitive
  return s;
}
// Is `cwd` inside (or equal to) any of `paths`? Empty cwd / no paths => false (can't confirm => out).
function withinScope(cwd, paths) {
  if (!cwd || !Array.isArray(paths) || !paths.length) return false;
  const c = normPath(cwd);
  if (!c) return false;
  for (const p of paths) {
    const base = normPath(p);
    if (base && (c === base || c.startsWith(base + '/'))) return true;
  }
  return false;
}
// A mode's declared scope paths, or [] if the mode ships no (valid) scope.json (=> not path-gated).
function loadModeScope(home, mode) {
  if (!mode || mode === 'general') return [];
  try {
    const cfg = JSON.parse(fs.readFileSync(`${modeDir(home, mode)}/scope.json`, 'utf8'));
    return (cfg && Array.isArray(cfg.paths)) ? cfg.paths.filter(p => typeof p === 'string' && p.trim()) : [];
  } catch (_) { return []; }
}
// Installed modes that declare a scope, as [{ mode, paths }]. Order = listModes() order.
function scopedModes(home) {
  const out = [];
  for (const m of listModes(home)) { const paths = loadModeScope(home, m); if (paths.length) out.push({ mode: m, paths }); }
  return out;
}
// The scoped mode whose directory contains `cwd` (the auto-activation target), or '' if none / cwd unknown.
function activeScopedMode(home, cwd) {
  if (!(typeof cwd === 'string' && cwd.trim())) return '';
  for (const { mode, paths } of scopedModes(home || homeDir())) if (withinScope(cwd, paths)) return mode;
  return '';
}
// Did a HUMAN explicitly pick the current mode (the `explicit` sentinel)? An explicit pick is the
// delegation escape: it wins over path auto-activation (e.g. /goddev inside a scoped mode's dir to
// build). The pin is read from the SAME source as the mode: if this session has its own `mode`
// overlay, its pin comes from the overlay; otherwise from the global file — so the two never disagree.
function isPinned(home, sid) {
  const h = home || homeDir();
  const s = sid || '';
  // A real session's pin is STRICTLY its own: read ONLY the overlay's `explicit`, never the global
  // pin. Otherwise a global pin (e.g. a `--global`/legacy/never-cleared `goddev`) would be inherited
  // by EVERY un-forked session and silently freeze autopilot routing for all of them — shared-state coupling
  // across concurrent sessions. A fresh session inherits the global *mode* as a default (via
  // requestedFolders' global fallback) but NOT the global *pin*, so godsense can still auto-route it
  // until it makes its own explicit pick (which forks the overlay). No session id => legacy global.
  if (s) return _exists(STATE.sessionPath(h, s, 'explicit'));
  return _exists(STATE.globalPath(h, 'explicit'));
}

// Validate ONE raw mode token to a real folder (built-in OR custom OR alias), or '' if unknown/general.
function validateFolder(modes, raw) {
  const low = String(raw || '').toLowerCase();
  if (!low || low === 'general') return '';
  if (modes.includes(low)) return low;                                  // exact folder (built-in or custom)
  const canon = canonicalMode(low);                                     // else map an alias to its folder
  if (canon && canon !== 'general' && modes.includes(canon)) return canon;
  return '';                                                            // unknown / folder absent => fail safe
}
// The REQUESTED mode validated to a real folder, IGNORING scope/cwd, else 'general'. "What mode did
// you ask for, does it even exist" — used by resolveMode + godmonitor to tell an intentional
// path-gated dormancy apart from a genuinely unloadable request. Optional `sid` for the overlay.
function requestedFolder(home, sid) {
  return requestedFolders(home, sid)[0] || 'general';
}
// The FULL validated, de-duped list of requested mode folders (multi-mode), in order. [] if none.
function requestedFolders(home, sid) {
  const h = home || homeDir();
  const modes = listModes(h);
  const out = [];
  for (const raw of requestedModesRaw(h, sid)) { const f = validateFolder(modes, raw); if (f && !out.includes(f)) out.push(f); }
  return out;
}

// Pass ONE mode through its own path-gate: returns the mode if it's allowed here, else '' (dropped).
// A non-scoped mode is always allowed; a scoped mode (ships scope.json) is allowed only when cwd is
// inside its scope. 'general' is never an effective mode here (it is the absence of a mode).
function gateMode(home, cwd, mode, haveCwd) {
  if (!mode || mode === 'general') return '';
  const sp = loadModeScope(home, mode);
  if (sp.length) return (haveCwd && withinScope(cwd, sp)) ? mode : '';
  return mode;
}
// The active mode(s) for this session, as an ORDERED LIST (primary first) — supports MULTIPLE modes
// running at once. Optional `cwd` engages the path-gate; optional `sid` engages the per-session
// overlay. Precedence mirrors the historical single-mode resolver:
//   (A) explicit human PIN: honor the requested set; scoped members hard-gated to their dir. (A human
//       `add`/select pins, so autopilot yields and the chosen set survives.)
//   (B) PATH AUTO-ACTIVATION (not pinned): cwd inside a scoped mode's dir turns THAT mode on and it
//       OWNS the session (overrides the requested set) — exactly as before.
//   (C) the requested set (not pinned), each scoped member hard-gated.
// Fail-safe: anything missing/unreadable/unknown => ['general']. Never throws. For a single requested
// mode this returns exactly what the old resolveMode returned (wrapped in a 1-element list).
function resolveModes(home, cwd, sid) {
  const h = home || homeDir();
  const requested = requestedFolders(h, sid);                           // [] if nothing valid was asked for
  const haveCwd = typeof cwd === 'string' && cwd.trim() !== '';
  const eff = [];
  const add = (m) => { if (m && !eff.includes(m)) eff.push(m); };

  // (A) explicit pin: honor the requested set (one or many); scoped members hard-gated.
  if (requested.length && isPinned(h, sid)) {
    for (const m of requested) add(gateMode(h, cwd, m, haveCwd));
    return eff.length ? eff : ['general'];
  }
  // (B) path auto-activation OVERRIDES the requested set (same as the old resolver's early return).
  if (haveCwd) { const m = activeScopedMode(h, cwd); if (m) return [m]; }
  // (C) the requested set, each scoped member hard-gated.
  for (const m of requested) add(gateMode(h, cwd, m, haveCwd));
  return eff.length ? eff : ['general'];
}
// Back-compat single value: the PRIMARY active mode. Every legacy 2-arg call site keeps working;
// pass `sid` (3rd arg) to engage the per-session overlay.
function resolveMode(home, cwd, sid) { return resolveModes(home, cwd, sid)[0] || 'general'; }
// Read + parse a mode's gate.json. Returns {} on any miss/parse error (=> base gate behavior).
function loadGateConfig(home, mode) {
  if (!mode || mode === 'general') return {};
  try {
    const cfg = JSON.parse(fs.readFileSync(`${modeDir(home, mode)}/gate.json`, 'utf8'));
    return (cfg && typeof cfg === 'object') ? cfg : {};
  } catch (_) { return {}; }
}
// Combine the gate.json overrides of an active-mode SET into one effective config (multi-mode). For a
// single mode this returns loadGateConfig(mode) UNCHANGED, so single-mode behavior is byte-for-byte
// identical. For 2+ modes:
//   - accepted-proof + claim arrays (extraClaim/extraTestCmd/extraFileReadCmd/extraEvidence/
//     extraVerifyTools/confirmCommands) => UNION: a claim word from ANY active mode gates, and a proof
//     valid for ANY active mode clears (you legitimately have every active mode's tools available).
//   - reReadClears => AND (strictest wins): false if ANY active mode requires a real run, so the most
//     demanding mode's "a re-read is not proof" rule is honored.
const _GATE_ARRAYS = ['extraClaim', 'extraTestCmd', 'extraFileReadCmd', 'extraEvidence', 'extraVerifyTools', 'confirmCommands'];
// A mode is "RUN-STRICT" when a bare re-read is NOT proof AND it accepts NO tool-name-as-proof — i.e.
// it demands an actual command RUN (qa / data-analyst / ci-cd). Such a mode's floor must not be
// laundered away by another mode's passive proof when they run together.
function _isRunStrict(cfg) {
  return cfg && cfg.reReadClears === false && (!Array.isArray(cfg.extraVerifyTools) || cfg.extraVerifyTools.length === 0);
}
// A "SOFT/RETRIEVAL" mode is re-read-friendly AND tool-proof — today only `researcher`. Its proof
// channels are external-FACT retrieval (verify-tools = WebSearch/WebFetch; extraTestCmd = `npm view`,
// `gh api`, `git ls-remote`, `pip index versions`), NOT verification of LOCAL work. When such a mode
// runs alongside ANY STRICT-FLOOR mode (a mode that forbids passive proof — reReadClears:false), BOTH its
// channels must be dropped so a fact-fetch can't launder a "built / tests pass / data / deploy-green /
// deployment-ready" claim. This is precise: genuine command-proof modes (developer's `mvn test` /
// `node repro` / `playwright screenshot` — debugger + ui-ux are now part of developer) are NOT soft (they
// ship real runners), so their test commands are preserved — no over-block.
function _isSoftRetrieval(cfg) {
  return cfg && cfg.reReadClears !== false && Array.isArray(cfg.extraVerifyTools) && cfg.extraVerifyTools.length > 0;
}
function combineGateConfigs(home, modes) {
  const real = (Array.isArray(modes) ? modes : [modes]).filter(m => m && m !== 'general');
  if (real.length === 0) return {};
  if (real.length === 1) return loadGateConfig(home, real[0]);          // exact single-mode parity
  const cfgs = real.map(m => loadGateConfig(home, m) || {});
  const anyRunStrict = cfgs.some(_isRunStrict);
  // A STRICT-FLOOR mode forbids passive proof (reReadClears:false) — qa/data/ci-cd (run-strict) AND the
  // tool-carrying strict modes developer/web-builder. A soft/retrieval mode's external-fact proof must
  // not launder ANY of these (not just run-strict ones), so a `developer`/`web-builder` build/readiness
  // claim can't be cleared by a researcher WebSearch/`npm view`. (Pre-collapse this keyed on run-strict
  // only, which let developer+researcher and web-builder+researcher launder — fixed.)
  const anyStrictFloor = cfgs.some(c => c && c.reReadClears === false);
  const out = {}; for (const k of _GATE_ARRAYS) out[k] = [];
  let reReadClears = true;
  for (const c of cfgs) {
    const softProofMode = anyStrictFloor && _isSoftRetrieval(c);        // researcher beside ANY strict-floor mode
    for (const k of _GATE_ARRAYS) {
      if (!Array.isArray(c[k])) continue;
      // Drop a soft/retrieval mode's PROOF channels (verify-tools + retrieval extraTestCmd) so a
      // fact-fetch can't clear the strict mode's claim. Claim words / confirmCommands still union
      // (more claims gate, more guards apply = strictly safer).
      if (softProofMode && (k === 'extraTestCmd' || k === 'extraVerifyTools')) continue;
      out[k] = out[k].concat(c[k]);
    }
    if (c.reReadClears === false) reReadClears = false;                 // strictest re-read rule wins
  }
  out.reReadClears = reReadClears;
  // Belt-and-suspenders: with ANY run-strict member (qa/data/ci-cd — no tool-as-proof), NO verify-TOOL
  // (from any mode, even a non-soft tool-proof one like developer's screenshot/repro tools) may clear —
  // only a real command RUN does. Kept run-strict-ONLY so that a tool-proof strict mode running WITHOUT a
  // run-strict sibling (e.g. developer+researcher) still clears via its OWN tool (developer's screenshot),
  // while the soft sibling's tools are already dropped above. The base TEST_CMD (in the gate itself) is
  // always present, so genuine verification is never blocked.
  if (anyRunStrict) out.extraVerifyTools = [];
  return out;
}
// Read a mode's text asset (contract.md / reminder.txt). '' on any miss => caller falls back to base.
function readModeAsset(home, mode, file) {
  if (!mode || mode === 'general') return '';
  try { return fs.readFileSync(`${modeDir(home, mode)}/${file}`, 'utf8'); } catch (_) { return ''; }
}

module.exports = {
  ALIASES, PRIMARY, GODNAME, HANDOFFS, STATE,
  homeDir, modesRoot, modeDir, listModes,
  canonicalMode, requestedMode, requestedModesRaw, requestedFolder, requestedFolders, validateFolder,
  resolveMode, resolveModes, loadGateConfig, combineGateConfigs, readModeAsset, handoffsFor, handoffGuidance,
  // path-gating (scoped modes)
  normPath, withinScope, loadModeScope, scopedModes, activeScopedMode, isPinned, gateMode,
};
