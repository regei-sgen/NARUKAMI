#!/usr/bin/env node
// detect-edit-loop.js — PostToolUse(Write|Edit|MultiEdit|NotebookEdit). ADVISORY ONLY, never blocks.
//
// Doom loops: once an agent has committed to a plan it tends to make small variations on the same
// broken approach rather than step back — LangChain observed 10+ near-identical edits to a single
// file in real Terminal-Bench traces, and shipped a LoopDetectionMiddleware for exactly this. A
// keyword stop-gate cannot see it, because a thrashing turn makes no completion claim at all: it
// just burns tokens and wall-clock with no progress signal anywhere.
//
// This keeps a per-session count of edits per file path and, past a threshold, injects a nudge
// naming the file and the count. It is a HEURISTIC around a current model limitation, not a
// correctness control — so it advises and never denies.
//
// Fail-OPEN on any error (emit nothing, exit 0).

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const CLAUDE_DIR = (process.env.CLAUDE_CONFIG_DIR || `${HOME}/.claude`).replace(/\\/g, '/');
const AUDIT = `${CLAUDE_DIR}/hook-audit.log`;
const STATE_DIR = `${CLAUDE_DIR}/godmode-sessions`;
const MUT = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// 5 is deliberately above normal iteration (write → test → fix → test → fix) so ordinary work never
// trips it; re-nag every 3 after that rather than on every edit, which would become noise.
const THRESHOLD = Number(process.env.GODMODE_LOOP_THRESHOLD) || 5;
const RENAG = 3;

function audit(line) {
  try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [edit-loop] ${line}\n`); } catch (_) {}
}
function sanitizeSid(s) { return String(s || 'nosid').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120); }

function main(raw) {
  let d;
  try { d = JSON.parse(raw); } catch (_) { return ''; }
  const tool = d.tool_name || d.toolName || '';
  if (!MUT.has(tool)) return '';
  const inp = d.tool_input || d.toolInput || {};
  const fp = String(inp.file_path || inp.notebook_path || '').replace(/\\/g, '/');
  if (!fp) return '';

  const sid = sanitizeSid(d.session_id);
  const store = path.join(STATE_DIR, sid, 'edit-counts.json');
  let counts = {};
  try { counts = JSON.parse(fs.readFileSync(store, 'utf8')) || {}; } catch (_) { counts = {}; }
  counts[fp] = (counts[fp] || 0) + 1;
  const n = counts[fp];
  try {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify(counts));
  } catch (_) { /* state is best-effort; a lost count only weakens the nudge */ }

  if (n < THRESHOLD || (n - THRESHOLD) % RENAG !== 0) return '';
  audit(`NUDGE sid=${sid} file=${fp.split('/').pop()} edits=${n}`);
  const name = fp.split('/').pop();
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `[loop-detector] You have now edited ${name} ${n} times this session (${fp}).\n` +
        `Repeated small edits to one file usually mean the current approach is wrong rather than ` +
        `nearly right. Before editing it again: run the thing and read the actual failure, state ` +
        `what you believe the cause is, and say why the previous ${n - 1} edits did not fix it. ` +
        `If you cannot name the cause, stop editing and investigate instead.`,
    },
  });
}

// In-process entrypoint: godmode-gate.mjs requires this module and calls it directly, avoiding a
// second `node` start (~150 ms) per matching tool call. Without this export the wrapper falls back
// to spawning the file as a CLI — which is what it was doing.
module.exports = main;

if (require.main === module) {
  let data = '';
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    let out = '';
    try { out = main(data); } catch (_) { out = ''; }
    if (out) process.stdout.write(out);
    process.exit(0);
  });
}
