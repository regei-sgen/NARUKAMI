#!/usr/bin/env node
'use strict';
// godstate-core.js — per-session + global STATE STORE for the GODCLAUDE deterministic layer.
//
// Single source of truth for WHERE each piece of layer state lives. Before this module, every
// sentinel was one GLOBAL file under ~/.claude, so two concurrent Claude Code sessions shared a
// single mode and stomped each other. This module adds a PER-SESSION overlay keyed by the Claude
// Code session id, layered over the legacy global files:
//
//   read  precedence:  session overlay  ->  global file  ->  (caller default)
//   write target:      session overlay when a session id is present, else the global file
//
// Session id source (the CALLER passes it in — this module never reads it implicitly, so it stays
// pure + testable):  hooks pass the stdin payload's `session_id`; the CLI passes
// process.env.CLAUDE_CODE_SESSION_ID. Absent / unusable id => sid '' => NO overlay => pure legacy
// global behavior (byte-for-byte as before this module existed). Subagents inherit the parent
// session id, so a session's modes + memory are shared by its subagents and isolated from others.
//
// FAIL-SAFE: every fs op is guarded; nothing throws to a hook. Honors DET_HOOKS_HOME (tests).

const fs = require('node:fs');
const os = require('node:os');

function homeDir() {
  return (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
}
function claudeDir(home) { return `${home || homeDir()}/.claude`; }

// --- session id ---------------------------------------------------------------------------------
// Sanitize a session id into ONE safe path segment, or '' if unusable. Session ids are UUIDs in
// practice; we still hard-reject anything path-ish so a crafted id can never escape the sessions
// root (defense in depth — the value originates from the Claude Code payload/env, not the model).
function sanitizeSid(sid) {
  const s = String(sid == null ? '' : sid).trim();
  if (!s || s === '.' || s === '..') return '';
  if (s.length > 128) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return '';   // no '/', '\\', ':', whitespace, ...
  return s;
}
// The CLI's view of "which session am I in" (env). Hooks DON'T use this — they pass payload.session_id.
function envSid() { return sanitizeSid(process.env.CLAUDE_CODE_SESSION_ID || ''); }

const SESSIONS_DIRNAME = 'godmode-sessions';
function sessionsRoot(home) { return `${claudeDir(home)}/${SESSIONS_DIRNAME}`; }
// Absolute dir for one session's overlay, or '' if the id is unusable (=> no overlay, global only).
function sessionDir(home, sid) { const s = sanitizeSid(sid); return s ? `${sessionsRoot(home)}/${s}` : ''; }

// --- sentinel name -> legacy GLOBAL file path ---------------------------------------------------
// Logical names used across the layer. The overlay file (inside a session dir) uses the SAME logical
// name; the global file keeps its historical `godmode-*` name for backward compatibility.
const GLOBAL_FILE = {
  mode: 'godmode-mode',
  active: 'godmode-active',
  explicit: 'godmode-explicit',
  autosession: 'godmode-autosession',   // aggressive auto-pilot preference (god modes preferred; normal only if easy)
  keywords: 'godmode-keywords',
  'godsite-scope': 'godsite-scope',
};
function globalPath(home, name) { return `${claudeDir(home)}/${GLOBAL_FILE[name] || name}`; }
function sessionPath(home, sid, name) { const d = sessionDir(home, sid); return d ? `${d}/${name}` : ''; }

function safeExists(p) { try { return !!p && fs.existsSync(p); } catch (_) { return false; } }
function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }
function firstLine(txt) { return (String(txt == null ? '' : txt).split('\n').map(l => l.trim()).find(Boolean) || ''); }

// --- generic read / write (overlay -> global) ---------------------------------------------------
// RAW text of a sentinel with overlay-then-global precedence; null if neither exists.
function readState(home, sid, name) {
  const sp = sessionPath(home, sid, name);
  if (sp && safeExists(sp)) { const v = safeRead(sp); if (v != null) return v; }
  const gp = globalPath(home, name);
  if (safeExists(gp)) { const v = safeRead(gp); if (v != null) return v; }
  return null;
}
function _spinMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} }
// Write `content` to `file` ATOMICALLY (temp + rename, so a concurrent reader never sees a torn file).
// On Windows, renameSync over a target a reader holds OPEN fails EPERM/EBUSY/EACCES — so retry a few
// times (the reader closes in microseconds), and if it STILL fails, fall back to a DIRECT write so the
// value is never silently DROPPED (Windows allows write-over-open-for-read; the only cost is a rare
// torn read, which self-heals on the next read). Net: ~0 dropped writes AND ~0 torn reads. Returns bool.
function atomicWrite(file, content, dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const tmp = `${file}.tmp.${process.pid}`;
  try { fs.writeFileSync(tmp, content); } catch (_) { return false; }
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); return true; }
    catch (e) {
      const code = (e && e.code) || '';
      if (i < 4 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY')) { _spinMs(4); continue; }
      break;
    }
  }
  // rename kept failing — fall back to a direct write so the write LANDS (never silently dropped).
  try { fs.writeFileSync(file, content); try { fs.rmSync(tmp, { force: true }); } catch (_) {} return true; }
  catch (_) { try { fs.rmSync(tmp, { force: true }); } catch (__) {} return false; }
}
// Write a sentinel. Overlay when a session id is present (creating the dir), else the global file.
// Returns the path written, or '' on failure.
function writeState(home, sid, name, content) {
  const sp = sessionPath(home, sid, name);
  const dir = sp ? sessionDir(home, sid) : claudeDir(home);
  const target = sp || globalPath(home, name);
  return atomicWrite(target, content, dir) ? target : '';
}
// Remove a sentinel. By default clears BOTH the session overlay AND the global file (used by `off`,
// which must fully disarm). Pass scope:'session' to clear only the overlay, 'global' for only global.
function clearState(home, sid, name, scope) {
  const sp = sessionPath(home, sid, name);
  if (scope !== 'global' && sp) { try { fs.rmSync(sp, { force: true }); } catch (_) {} }
  if (scope !== 'session') { try { fs.rmSync(globalPath(home, name), { force: true }); } catch (_) {} }
}

// --- FLAGS (tri-state overlay over a global default) --------------------------------------------
// A boolean sentinel (autosession/keywords/active). Semantics:
//   - session overlay file present: its content decides — first non-empty line in
//     {off,0,false,no,disable,disabled} => OFF (lets a session opt OUT of a global default-on);
//     anything else (incl. empty) => ON.
//   - no overlay: inherit the GLOBAL file's existence (today's behavior).
const OFF_WORDS = new Set(['off', '0', 'false', 'no', 'disable', 'disabled']);
function flagOn(home, sid, name) {
  const sp = sessionPath(home, sid, name);
  if (sp && safeExists(sp)) return !OFF_WORDS.has(firstLine(safeRead(sp)).toLowerCase());
  return safeExists(globalPath(home, name));
}
// Is the layer ARMED for this session? Tri-state like any flag: a session `active` overlay DECIDES
// (its content `off`/0/false => dormant, so a session can opt OUT of a global default-on); with no
// overlay, the global sentinel decides. (Env override GODMODE_ACTIVE is handled by the wrapper.)
function armed(home, sid) { return flagOn(home, sid, 'active'); }

// --- multi-mode list ----------------------------------------------------------------------------
// The RAW ordered list of requested modes (primary first), de-duped, from the highest-precedence
// source that is set:  env GODMODE_MODE (single, for tests)  ->  session overlay `mode` (multi,
// newline-separated)  ->  global `godmode-mode` (single line, legacy).  [] if nothing is set.
function requestedModeList(home, sid) {
  const env = (process.env.GODMODE_MODE || '').trim();
  if (env) return [env];
  const sp = sessionPath(home, sid, 'mode');
  let txt = null;
  if (sp && safeExists(sp)) txt = safeRead(sp);
  else txt = safeRead(globalPath(home, 'mode'));
  if (txt == null) return [];
  const out = [];
  for (const raw of String(txt).split('\n')) { const v = raw.trim(); if (v && !out.includes(v)) out.push(v); }
  return out;
}
// Back-compat single value: the FIRST requested mode (what requestedMode() returned before). '' if none.
function requestedModePrimary(home, sid) { return requestedModeList(home, sid)[0] || ''; }
// Does THIS session have its own `mode` overlay file? (When true, the session's pin/explicit state
// must also be read from the overlay — not the global file — so the two never disagree.)
function modeOverlayActive(home, sid) { const sp = sessionPath(home, sid, 'mode'); return !!(sp && safeExists(sp)); }

// --- session lifecycle / GC ---------------------------------------------------------------------
// List existing session ids (overlay dir names). [] if none / unreadable.
function listSessions(home) {
  try {
    return fs.readdirSync(sessionsRoot(home), { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch (_) { return []; }
}
function removeSession(home, sid) {
  const d = sessionDir(home, sid);
  if (d) { try { fs.rmSync(d, { recursive: true, force: true }); return true; } catch (_) {} }
  return false;
}
// Prune stale session overlays so the store stays bounded. Removes dirs whose mtime is older than
// maxAgeMs, and (if still over maxKeep) the oldest beyond the cap. NEVER removes `keepSid` (the
// current session). Fail-safe + cheap; called at SessionStart. Returns the count removed.
function gcSessions(home, opts) {
  const o = opts || {};
  const maxAgeMs = typeof o.maxAgeMs === 'number' ? o.maxAgeMs : 14 * 24 * 3600 * 1000;
  const maxKeep = typeof o.maxKeep === 'number' ? o.maxKeep : 200;
  const keepSid = sanitizeSid(o.keepSid || '');
  let removed = 0;
  let entries = [];
  try {
    const root = sessionsRoot(home);
    for (const name of listSessions(home)) {
      if (name === keepSid) continue;
      // An UNKNOWN mtime (a transient statSync failure — EBUSY/EPERM from AV / indexer / a concurrent
      // godclaude process holding the dir) must mean KEEP, never age-0 => delete. A stat-failing dir
      // may be a LIVE concurrent session; treating it as maximally stale would GC another session's
      // overlay + shared memory. Skip it from BOTH the age prune and the count-cap sort.
      let mtime = null; try { mtime = fs.statSync(`${root}/${name}`).mtimeMs; } catch (_) {}
      if (mtime == null) continue;
      entries.push({ name, mtime });
    }
  } catch (_) { return 0; }
  // NOTE: time-based pruning is intentionally skipped when the clock is unavailable in the sandbox
  // (Date is stubbed in workflow scripts, not here) — Date.now() is fine in a normal hook process.
  const now = Date.now();
  for (const e of entries) { if (now - e.mtime > maxAgeMs) { if (removeSession(home, e.name)) removed++; e._gone = true; } }
  const live = entries.filter(e => !e._gone).sort((a, b) => a.mtime - b.mtime);
  if (live.length > maxKeep) {
    for (const e of live.slice(0, live.length - maxKeep)) { if (removeSession(home, e.name)) removed++; }
  }
  return removed;
}

module.exports = {
  homeDir, claudeDir, sanitizeSid, envSid,
  sessionsRoot, sessionDir, globalPath, sessionPath,
  readState, writeState, clearState, flagOn, armed, atomicWrite,
  requestedModeList, requestedModePrimary, modeOverlayActive,
  listSessions, removeSession, gcSessions,
  GLOBAL_FILE, SESSIONS_DIRNAME, OFF_WORDS,
};
