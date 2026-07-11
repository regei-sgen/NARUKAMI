#!/usr/bin/env node
// godmode-gate.mjs — flag-gate wrapper for the GODCLAUDE deterministic operating layer.
//
// godclaude/godmode is OPT-IN (complex tasks only / when stated). This wrapper sits in
// front of each godclaude hook (contract injector, anti-drift, proof-of-work gate) and
// only runs the real hook when godmode is ACTIVE.
//
//   ACTIVE  =  sentinel file ~/.claude/godmode-active exists
//              (env override: GODMODE_ACTIVE=1 forces active, =0 forces inactive — for tests)
//
// INACTIVE (default): consume stdin, emit nothing, exit 0 (no inject / no block). Logs nothing —
//   the layer isn't "in use", so there's no performance to measure.
// ACTIVE: transparently run `node <realHook>`, forwarding stdin and relaying the real hook's
//   stdout + (effective) exit unchanged, AND append one performance record to the perf log.
//
// PERFORMANCE LOG (~/.claude/godmode-perf.log, JSONL, one line per ACTIVE invocation):
//   {"ts","hook","event","active":true,"ms","emitted","blocked","dispatch"}
//     ms      = wall-time of the real hook (its node spawn + work) in milliseconds
//     emitted = did the real hook produce any stdout (an injection, or a block decision)?
//     blocked = did it emit a `"decision":"block"` (gate only)?
//     dispatch= how the real hook ran: "in-process" (normal), "spawn" (stale copy w/o a run() export,
//               fell back to a 2nd `node`), or "error" (the in-process hook threw → emitted nothing,
//               fail-open). godmode-stats.mjs keys off this to flag spawn-fallbacks / fail-opens.
//   Analyze it with godmode-stats.mjs. Disable logging with GODMODE_PERF=0. Auto-rotates at 10 MB.
//
// Wired in settings.json as:  node .../godmode-gate.mjs .../<real-hook>.js
// Honors DET_HOOKS_HOME (sandbox/tests). Fail-OPEN: any error -> exit 0 with no output.

'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); // wrapper is ESM; real hooks are CJS — require() to dispatch in-process

const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const SENTINEL = `${HOME}/.claude/godmode-active`;
// Per-session state store: lets a session arm the layer for itself (overlay) without a global sentinel.
let STATE; try { STATE = require('./godstate-core.js'); } catch (_) { STATE = null; }
const PERF = `${HOME}/.claude/godmode-perf.log`;
const MAX_PERF_BYTES = 10 * 1024 * 1024; // rotate the perf log past 10 MB (keep one .1 backup)
const realHook = process.argv[2];
const hookName = realHook ? path.basename(realHook).replace(/\.[cm]?js$/i, '') : '(none)';

// ARMED when GODMODE_ACTIVE forces it, OR the global sentinel exists, OR THIS session armed its own
// overlay (via godstate). The per-session overlay lets two sessions arm independently — one can be
// running modes while the other stays dormant. `sid` is the payload's session_id ('' when absent).
function active(sid) {
  const env = process.env.GODMODE_ACTIVE;
  if (env === '1') return true;
  if (env === '0') return false;
  if (STATE && typeof STATE.armed === 'function') { try { return STATE.armed(HOME, sid); } catch (_) {} }
  try { return fs.existsSync(SENTINEL); } catch (_) { return false; }
}

function logPerf(rec) {
  if (process.env.GODMODE_PERF === '0') return; // explicit opt-out
  try {
    try { const st = fs.statSync(PERF); if (st.size > MAX_PERF_BYTES) fs.renameSync(PERF, `${PERF}.1`); } catch (_) {}
    fs.appendFileSync(PERF, JSON.stringify(rec) + '\n');
  } catch (_) {}
}

// Fallback for a hook that doesn't export an in-process runner (e.g. a stale copy from a partial
// upgrade): run it the old way in its own `node` process, relaying stdout. Mirrors the pre-in-process
// behavior exactly, so the wrapper is never worse than before.
function spawnHook(realHook, data) {
  try { return execFileSync('node', [realHook], { input: data, encoding: 'utf8' }); }
  catch (e) { return (e && e.stdout) ? e.stdout : ''; }
}

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  try {
    let input = {}; try { input = JSON.parse(data || '{}'); } catch (_) {}
    const sid = typeof input.session_id === 'string' ? input.session_id : '';
    if (!realHook || !active(sid)) process.exit(0); // dormant: no output => allow / no-inject; nothing to log
    const event = input.hook_event_name || '';

    const t0 = process.hrtime.bigint();
    let out = '', dispatch = 'in-process';
    try {
      // In-process dispatch: each real hook exports a synchronous run(data)→string (the gate exports
      // `decide`). Calling it here avoids spawning a SECOND `node` per hook event — the layer's biggest
      // fixed overhead. A module that doesn't export a function (a stale copy from a partial upgrade)
      // transparently falls back to the original spawn path, so this is never worse than before.
      const run = require(realHook);
      if (typeof run === 'function') {
        out = run(data) || '';
      } else {
        dispatch = 'spawn';
        out = spawnHook(realHook, data);
      }
    } catch (e) {
      // An in-process hook threw (unexpected — the hooks are internally fail-open). Emit nothing, but
      // record that this event errored. Do NOT re-run via spawn: that could double the hook's side
      // effects (e.g. anti-drift writing godmode-mode twice). Fail-open == allow / no-inject.
      dispatch = 'error';
      out = '';
    }
    const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100; // ms, 2 decimals

    // Relay the real hook's decision FIRST so logging never adds latency to the gate, then record perf.
    if (out) process.stdout.write(out);
    logPerf({ ts: new Date().toISOString(), hook: hookName, event, active: true, ms, emitted: !!out, blocked: /"decision"\s*:\s*"block"/.test(out), dispatch });
    process.exit(0);
  } catch (_) {
    process.exit(0); // fail-open
  }
});
