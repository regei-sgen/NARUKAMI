#!/usr/bin/env node
// godmode-stats.mjs — performance & behavior report for the GODCLAUDE layer.
//
// Reads (read-only; never modifies anything):
//   ~/.claude/godmode-perf.log   JSONL written by godmode-gate.mjs on each ACTIVE invocation
//   ~/.claude/hook-audit.log     the proof-of-work gate's ALLOW/BLOCK/DIAG decisions
// and prints: per-hook latency (count, p50/p95/max/total), gate allow-vs-block + reason mix,
// flush-race health, and DATA-DRIVEN suggestions for improving the layer.
//
// The analysis + suggestions are computed by hooks/godimprove-core.js — the SINGLE SOURCE OF TRUTH shared
// with godmonitor.js, which surfaces the high-signal subset at SessionStart (closing the improvement loop).
//
//   node ~/.claude/godmode-stats.mjs            # full report
//   node ~/.claude/godmode-stats.mjs --json     # machine-readable summary
// Honors DET_HOOKS_HOME (for tests/sandboxes).

import os from 'node:os';
import improveCore from './hooks/godimprove-core.js';

const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const PERF = `${HOME}/.claude/godmode-perf.log`;
const AUDIT = `${HOME}/.claude/hook-audit.log`;
const asJson = process.argv.includes('--json');
// By default the report reflects the last 14 days (already-fixed issues + old test-fixture noise age out
// instead of nagging forever). `--all` shows full log history; `--days N` sets a custom window.
const allHistory = process.argv.includes('--all');
const daysArg = process.argv.indexOf('--days');
const windowDays = daysArg >= 0 && process.argv[daysArg + 1] ? Number(process.argv[daysArg + 1]) : 14;

// All parsing + aggregation + suggestions live in the shared engine (single source of truth).
const A = improveCore.analyze(HOME, { all: allHistory, windowDays });
const { perfSpan, hookStats, dispatchMix } = A;
const { allow, block, blockRate, settled, unsettled, allowReasons, diagEvents, decisions } = A.gate;
const suggestions = A.suggestions.map(s => s.text); // report + --json present plain strings (output shape unchanged)

// ---------- output ----------
if (asJson) {
  console.log(JSON.stringify({ perfSpan, dispatch: dispatchMix, hookStats, gate: { allow, block, blockRate, settled, unsettled, allowReasons, diagEvents }, suggestions }, null, 2));
  process.exit(0);
}

const bar = '─'.repeat(64);
console.log(`\nGODCLAUDE — performance & behavior report`);
console.log(bar);
console.log(`perf log:  ${PERF}`);
console.log(`audit log: ${AUDIT}`);
console.log(`scope:     ${allHistory ? 'ALL history (--all)' : `last ${windowDays} days (default; --all for full history)`}`);
if (perfSpan) console.log(`window:    ${perfSpan.from}  →  ${perfSpan.to}`);

console.log(`\n▎Per-hook latency (ACTIVE invocations only)`);
if (!hookStats.length) {
  console.log('  (no perf records yet — is godmode active? godmode-gate logs only when active)');
} else {
  console.log('  hook                              count   p50ms   p95ms   maxms   total-ms');
  for (const h of hookStats) {
    console.log('  ' + h.hook.padEnd(32) + String(h.count).padStart(6) + String(h.p50).padStart(8) + String(h.p95).padStart(8) + String(h.max).padStart(8) + String(h.totalMs).padStart(11));
  }
  console.log(`  dispatch: in-process ${dispatchMix['in-process']}  spawn ${dispatchMix.spawn}  error ${dispatchMix.error}` + (dispatchMix.legacy ? `  legacy(pre-fix) ${dispatchMix.legacy}` : '') +
    (dispatchMix.error ? '   ⚠ error = in-process throw → failed open (NOT enforced)' : ''));
}

console.log(`\n▎Proof-of-work gate decisions (from hook-audit.log)`);
if (!decisions) {
  console.log('  (no gate decisions logged yet)');
} else {
  console.log(`  ALLOW: ${allow}   BLOCK: ${block}   block-rate: ${(blockRate * 100).toFixed(1)}%`);
  console.log(`  flush: ${settled} settled / ${unsettled} UNSETTLED`);
  const reasons = Object.entries(allowReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length) {
    console.log('  ALLOW reasons:');
    for (const [r, n] of reasons) console.log(`    ${String(n).padStart(5)}  ${r}`);
  }
  const evs = Object.entries(diagEvents).sort((a, b) => b[1] - a[1]);
  if (evs.length) console.log('  events seen: ' + evs.map(([e, n]) => `${e}=${n}`).join('  '));
}

console.log(`\n▎Suggestions to improve`);
if (!suggestions.length) console.log('  (nothing flagged)');
for (let i = 0; i < suggestions.length; i++) console.log(`  ${i + 1}. ${suggestions[i]}`);
console.log('');
