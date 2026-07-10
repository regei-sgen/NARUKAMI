#!/usr/bin/env node
'use strict';
// godmonitor-core.js — health / integrity checks for the GODCLAUDE mode system.
// Shared by the SessionStart godmonitor hook AND the godmonitor CLI (single source of truth).
// CommonJS; fail-safe (returns data, never throws to wrapped callers). Reuses the resolver for
// "which mode / where the assets live" so godmonitor and the gate can never disagree about the mode.
//
// What it watches ("monitor the god modes / won't lose its path"):
//   - DRIFT: the mode you ASKED for (godmode-mode / GODMODE_MODE) vs the mode that actually RESOLVED.
//     A non-general request that resolves to something else = the layer silently lost the path.
//   - INTEGRITY: the active mode's contract.md / reminder.txt / gate.json are present, non-empty, and
//     gate.json is valid JSON with real override keys (else the mode enforces nothing beyond base).
//   - PLUMBING: the hook scripts + base contract the layer needs are present.

const fs = require('node:fs');
const R = require('./godmode-mode.js'); // homeDir, modesRoot, modeDir, listModes, resolveMode, requestedMode, canonicalMode
let STATE; try { STATE = require('./godstate-core.js'); } catch (_) { STATE = null; } // per-session armed/flag overlay

const REQUIRED_HOOKS = ['godmode-mode.js', 'block-unverified-completion.js', 'inject-deterministic-contract.js', 'inject-anti-drift.js', 'godmode-gate.mjs'];
const MODE_FILES = ['contract.md', 'reminder.txt', 'gate.json'];

function exists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }
function nonEmpty(p) { try { return fs.statSync(p).size > 0; } catch (_) { return false; } }

// Integrity of ONE mode folder: files present + gate.json valid JSON with >=1 real override key.
function checkModeFolder(home, mode) {
  const dir = R.modeDir(home, mode);
  const issues = [];
  const files = {};
  for (const f of MODE_FILES) {
    const ok = exists(`${dir}/${f}`) && nonEmpty(`${dir}/${f}`);
    files[f] = ok;
    if (!ok) issues.push(`${mode}: missing/empty ${f}`);
  }
  let gateValid = false, gateKeys = 0;
  if (files['gate.json']) {
    try {
      const cfg = JSON.parse(fs.readFileSync(`${dir}/gate.json`, 'utf8'));
      gateValid = true;
      gateKeys = Object.keys(cfg).filter(k => !k.startsWith('_')).length;
      if (!gateKeys) issues.push(`${mode}: gate.json has no override keys (mode would enforce nothing beyond base)`);
    } catch (e) { issues.push(`${mode}: gate.json is INVALID JSON (${String(e.message || '').slice(0, 60)}) — gate silently falls back to base`); }
  }
  return { mode, files, gateValid, gateKeys, ok: issues.length === 0, issues };
}

// Integrity of ALL installed modes ("monitor ALL the god modes").
function auditAllModes(home) {
  let modes = [];
  try { modes = R.listModes(home).slice().sort(); } catch (_) {}
  return modes.map(m => checkModeFolder(home, m));
}

// Full health check of the ACTIVE configuration. `cwd` engages path-gating; `sid` (the session id)
// engages the per-session overlay so the monitor judges THIS session's mode(s), isolated from others.
function healthCheck(home, cwd, sid) {
  const h = home || R.homeDir();
  const s = sid || '';
  const claude = `${h}/.claude`;
  const issues = [];
  let armed = false;
  try {
    if (process.env.GODMODE_ACTIVE === '1') armed = true;
    else if (process.env.GODMODE_ACTIVE === '0') armed = false;
    else if (STATE && typeof STATE.armed === 'function') armed = STATE.armed(h, s);
    else armed = exists(`${claude}/godmode-active`);
  } catch (_) {}

  const haveCwd = typeof cwd === 'string' && cwd.trim() !== '';
  const requested = R.requestedMode(h, s);
  const effective = R.resolveMode(h, cwd, s);
  const effectiveModes = (() => { try { return R.resolveModes(h, cwd, s); } catch (_) { return [effective]; } })();
  const reqNorm = (requested || '').toLowerCase();

  // Path-gating awareness: distinguish an INTENTIONAL path-gated dormancy (you requested a scoped mode
  // shipping a scope.json, but cwd is outside its dir, so it's deliberately OFF) from a genuine LOST PATH
  // (the requested mode doesn't exist / didn't load). Only the latter is drift.
  const reqFolder = R.requestedFolder(h, s);                       // validated folder, ignoring scope; 'general' if unloadable
  const scopePaths = reqFolder !== 'general' ? R.loadModeScope(h, reqFolder) : [];
  const reqScoped = scopePaths.length > 0;
  const inScope = reqScoped && haveCwd && R.withinScope(cwd, scopePaths);
  const pathGatedDormant = reqScoped && !inScope;                 // scoped mode, off because cwd is outside it (or unknown)
  // auto-activation: a scoped mode turned on purely from cwd (the requested mode was general/other).
  const autoActivated = effective !== 'general' && effective !== reqFolder && R.loadModeScope(h, effective).length > 0;

  // drift = a non-general request that did NOT load, EXCEPT an intentional path-gated dormancy (not a bug).
  const drift = !!reqNorm && reqNorm !== 'general' && effective === 'general' && !pathGatedDormant;
  if (drift) issues.push(`LOST PATH: requested mode "${requested}" did not load — running as "general" (no matching mode folder or alias)`);

  for (const f of REQUIRED_HOOKS) if (!exists(`${claude}/hooks/${f}`)) issues.push(`missing plumbing: hooks/${f}`);
  if (!exists(`${claude}/deterministic-contract.md`)) issues.push('missing base contract: deterministic-contract.md');
  // godsense-core.js is load-bearing ONLY when auto-routing is on — flag it missing THEN (not for general),
  // else autopilot can be enabled while sensing is silently dead and the monitor reports healthy.
  // AUTOPILOT is the single auto-routing switch (godsense/godsession were merged into it), so routing is
  // ON iff `autosession` — mirror the engine's autoSessionEnabled() EXACTLY. (Computed inline, not via
  // require('./godsense-core.js'), because this very check fires when that engine file is missing — and
  // the removed `sense`/`session` sentinels must NOT count, else a stale legacy install false-warns.)
  const routingOn = (() => {
    try { if (STATE && typeof STATE.flagOn === 'function') return STATE.flagOn(h, s, 'autosession'); } catch (_) {}
    return exists(`${claude}/godmode-autosession`);
  })();
  if (routingOn && !exists(`${claude}/hooks/godsense-core.js`)) {
    issues.push('auto-routing (autopilot) is ON but hooks/godsense-core.js is missing — sensing is silently dead');
  }

  // Integrity of EVERY active mode (a session may run several at once). modeCheck keeps the primary's
  // shape for back-compat; issues accumulate across all active modes.
  let modeCheck = null;
  for (const em of effectiveModes) {
    if (!em || em === 'general') continue;
    const mc = checkModeFolder(h, em);
    if (!modeCheck) modeCheck = mc;
    for (const i of mc.issues) issues.push(i);
  }
  return { armed, requested, effective, effectiveModes, drift, pathGatedDormant, autoActivated, reqScoped, scopePaths, ok: issues.length === 0, issues, modeCheck };
}

// godmonitor's own heartbeat trail (reliable, independent of the gate's audit format).
const MONITOR_LOG = (home) => `${home || R.homeDir()}/.claude/godmonitor.log`;
const MAX_LOG = 5 * 1024 * 1024;
function logHeartbeat(home, rec) {
  try {
    const p = MONITOR_LOG(home);
    try { const st = fs.statSync(p); if (st.size > MAX_LOG) fs.renameSync(p, `${p}.1`); } catch (_) {}
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch (_) {}
}
function readHeartbeatTail(home, n) {
  try {
    const lines = fs.readFileSync(MONITOR_LOG(home), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-(n || 10)).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

// Best-effort per-mode gate activity from hook-audit.log (pairs a DIAG `mode=` with the next decision).
function gateActivity(home) {
  const tally = {};
  try {
    const lines = fs.readFileSync(`${home || R.homeDir()}/.claude/hook-audit.log`, 'utf8').split('\n');
    let curMode = 'general';
    for (const ln of lines) {
      const m = ln.match(/\bmode=([a-z-]+)/i); if (m) curMode = m[1];
      // Attribute each decision to the mode from its OWN turn's DIAG line, then reset — so an
      // early-exit decision in a later turn (which logs no mode=) isn't tallied under a stale mode.
      if (/\bBLOCK:/.test(ln)) { (tally[curMode] || (tally[curMode] = { allow: 0, block: 0 })).block++; curMode = 'general'; }
      else if (/\bALLOW:/.test(ln)) { (tally[curMode] || (tally[curMode] = { allow: 0, block: 0 })).allow++; curMode = 'general'; }
    }
  } catch (_) {}
  return tally;
}

module.exports = { healthCheck, checkModeFolder, auditAllModes, logHeartbeat, readHeartbeatTail, gateActivity, REQUIRED_HOOKS, MODE_FILES };
