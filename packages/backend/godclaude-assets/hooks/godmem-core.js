#!/usr/bin/env node
'use strict';
// godmem-core.js — PER-SESSION SHARED MEMORY for the GODCLAUDE layer.
//
// A tiny key->value store scoped to ONE Claude Code session. It is "shared" across everything in
// that session — every mode active in the session, every turn, and the session's subagents all
// read/write the SAME store — but it is ISOLATED from other sessions: session A can never see
// session B's memory. This is exactly the user requirement: each session has its own shared memory.
//
// Location:  ~/.claude/godmode-sessions/<sid>/memory/store.json   (per session)
//            ~/.claude/godmode-memory/store.json                  (fallback when there is no sid —
//            e.g. the CLI run from a plain terminal; never used inside a real Claude session).
//
// Stored values are strings (callers JSON-encode richer data). FAIL-SAFE: every fs/JSON op is
// guarded; a corrupt store reads as empty rather than throwing. Honors DET_HOOKS_HOME (tests).

const fs = require('node:fs');
const S = require('./godstate-core.js');

// Directory + file holding this session's (or the global fallback's) memory store.
function memDir(home, sid) {
  const sd = S.sessionDir(home, sid);
  return sd ? `${sd}/memory` : `${S.claudeDir(home)}/godmode-memory`;
}
function memFile(home, sid) { return `${memDir(home, sid)}/store.json`; }

// Bounds (gap #16): keep the store from growing without limit (every other sibling store rotates; this one
// previously didn't). Values are short shared notes, not blobs; item count is capped so the whole file stays
// small (it's JSON.parsed on every get/set/digest). Past the cap the OLDEST items (by ts) are evicted.
const MAX_VAL = 4096;    // chars per stored value
const MAX_ITEMS = 200;   // items per session store

// Sanitize a memory KEY to a compact, predictable token (so keys can appear in a one-line digest).
function cleanKey(k) {
  const s = String(k == null ? '' : k).trim().slice(0, 80);
  return s.replace(/[\r\n\t]+/g, ' ');
}

function load(home, sid) {
  const p = memFile(home, sid);
  let raw = null;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (_) { return { v: 1, items: {} }; }      // ENOENT / unreadable => genuinely empty (not corrupt)
  // Parse; a TORN read (a concurrent atomicWrite rename) can momentarily yield partial bytes — re-read
  // once before concluding the store is lost.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && obj.items && typeof obj.items === 'object') return obj;
    } catch (_) {}
    if (attempt === 0) { try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { break; } }
  }
  // Present-but-unparseable after a retry: do NOT return empty and let the next save() OVERWRITE it — that
  // would be silent, total, unrecoverable loss of every other key. Preserve the bytes aside for recovery,
  // THEN start fresh. (ENOENT already returned above, so this only fires on a real corrupt/partial file.)
  if (raw && raw.trim()) { try { fs.renameSync(p, `${p}.corrupt`); } catch (_) {} }
  return { v: 1, items: {} };
}
function save(home, sid, store) {
  // ATOMIC write via the shared helper: temp + rename with an EPERM retry and a direct-write fallback,
  // so a concurrent reader (memDigest in another turn / subagent) never sees a torn file AND the write
  // is never silently dropped on Windows. (The remaining load->mutate->save is last-writer-wins; values
  // are tiny so the window is sub-ms — acceptable for shared notes.)
  const body = JSON.stringify(store, null, 2);
  if (S && typeof S.atomicWrite === 'function') return S.atomicWrite(memFile(home, sid), body, memDir(home, sid));
  try { fs.mkdirSync(memDir(home, sid), { recursive: true }); fs.writeFileSync(memFile(home, sid), body); return true; } catch (_) { return false; }
}

// Stamp helper: ISO timestamp, but tolerate environments where Date is unavailable (returns '').
function nowIso() { try { return new Date().toISOString(); } catch (_) { return ''; } }

function memSet(home, sid, key, value) {
  const k = cleanKey(key);
  if (!k) return false;
  const store = load(home, sid);
  let v = String(value == null ? '' : value);
  if (v.length > MAX_VAL) v = v.slice(0, MAX_VAL); // bound a single value (it's surfaced + parsed every turn)
  store.items[k] = { value: v, ts: nowIso() };
  // Evict the oldest items (by ts; the just-set key carries the newest ts, so it is always kept) past the cap.
  const keys = Object.keys(store.items);
  if (keys.length > MAX_ITEMS) {
    keys.sort((a, b) => String(store.items[a].ts || '').localeCompare(String(store.items[b].ts || '')));
    for (const old of keys.slice(0, keys.length - MAX_ITEMS)) delete store.items[old];
  }
  return save(home, sid, store);
}
function memGet(home, sid, key) {
  const it = load(home, sid).items[cleanKey(key)];
  return it ? it.value : null;
}
function memDel(home, sid, key) {
  const store = load(home, sid);
  const k = cleanKey(key);
  if (!(k in store.items)) return false;
  delete store.items[k];
  return save(home, sid, store);
}
function memClear(home, sid) {
  try { fs.rmSync(memFile(home, sid), { force: true }); return true; } catch (_) { return false; }
}
// All entries as [{ key, value, ts }], newest-written last is NOT guaranteed (object order ~ insertion).
function memList(home, sid) {
  const items = load(home, sid).items;
  return Object.keys(items).map(k => ({ key: k, value: items[k] && items[k].value, ts: items[k] && items[k].ts }));
}
function memCount(home, sid) { return Object.keys(load(home, sid).items).length; }

// A COMPACT one-line digest for context injection. Bounded so the per-turn token cost stays small.
// '' when empty. Format: "[session-mem N] k1=v1; k2=v2 (+M more)".
function memDigest(home, sid, opts) {
  const o = opts || {};
  const maxItems = typeof o.maxItems === 'number' ? o.maxItems : 6;
  const maxVal = typeof o.maxVal === 'number' ? o.maxVal : 60;
  const maxTotal = typeof o.maxTotal === 'number' ? o.maxTotal : 360;
  const all = memList(home, sid);
  if (!all.length) return '';
  const shown = all.slice(0, maxItems).map(({ key, value }) => {
    let v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (v.length > maxVal) v = v.slice(0, maxVal - 1) + '…';
    return `${key}=${v}`;
  });
  const more = all.length - shown.length;
  // Cap the FINAL assembled string (prefix + body + suffix), not just the body — otherwise the
  // "[session-mem N] " prefix and " (+M more)" suffix overshoot maxTotal. maxTotal bounds the digest.
  const out = `[session-mem ${all.length}] ${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`;
  return out.length > maxTotal ? out.slice(0, maxTotal - 1) + '…' : out;
}

module.exports = {
  memDir, memFile, memSet, memGet, memDel, memClear, memList, memCount, memDigest, cleanKey,
};
