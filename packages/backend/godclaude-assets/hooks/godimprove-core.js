#!/usr/bin/env node
'use strict';
// godimprove-core.js — the GODCLAUDE self-improvement ENGINE (the closed-loop's brain).
//
// Single source of truth for the layer's data-driven self-diagnosis. Reads (read-only; never mutates):
//   ~/.claude/godmode-perf.log   JSONL written by godmode-gate.mjs on each ACTIVE invocation
//   ~/.claude/hook-audit.log     the proof/persistence gates' ALLOW/BLOCK/DIAG decisions
// and produces per-hook latency, dispatch mix, gate allow/block + reason mix, and SEVERITY-TAGGED
// improvement suggestions.
//
// Consumed by:
//   - godmode-stats.mjs   → the full CLI performance/behavior report (`node ~/.claude/godmode-stats.mjs`)
//   - godmonitor.js       → surfaces the HIGH-SIGNAL subset at SessionStart (closing the loop: the
//                           suggestions stop being buried in a log nobody runs and become live context).
//
// ADVISORY ONLY. It diagnoses + suggests; it NEVER edits code or config. The human/agent applies the fix
// (propose-don't-push). Fail-safe: any read error / missing log => empty data => no suggestions, never throws.

const fs = require('node:fs');
const os = require('node:os');

const num = (n) => (Math.round(n * 100) / 100);
function pctile(sorted, p) { if (!sorted.length) return 0; const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)); return sorted[i]; }
function homeOf(h) { return (h || process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/'); }
const readLines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()); } catch (_) { return []; } };

// Full analysis of the perf + audit logs → stats + severity-tagged suggestions.
// opts.windowDays (default 14): only consider log entries from the last N days, so ALREADY-FIXED issues and
// old test-fixture pollution age out instead of nagging every session for months (both logs rotate only at
// 10 MB ≈ 100+ days). opts.all=true bypasses the window (full-history view, exposed as `--all` on the CLI).
// Fixture lines (a `tx=` that is not a real <uuid>.jsonl / agent-*.jsonl session transcript) are always
// skipped — the test suite historically polluted the real log and must not skew live stats.
function analyze(h, opts = {}) {
  const HOME = homeOf(h);
  const PERF = `${HOME}/.claude/godmode-perf.log`;
  const AUDIT = `${HOME}/.claude/hook-audit.log`;
  const cutoff = opts.all ? 0 : Date.now() - (typeof opts.windowDays === 'number' ? opts.windowDays : 14) * 86400000;
  const tooOldTs = (ts) => { if (opts.all || !ts) return false; const t = Date.parse(ts); return Number.isFinite(t) && t < cutoff; };
  const lineTs = (s) => { const m = s.match(/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/); return m ? m[1] : null; };
  const UUID_TX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
  // A `tx=` naming anything but a real session/agent transcript is a TEST FIXTURE (block_basic.jsonl, sm_*,
  // mon_*, wf_main.jsonl, …). Lines without a tx= (bare ALLOW:/BLOCK:) are kept — they can't be attributed.
  const isFixtureLine = (s) => { const m = s.match(/\btx=(\S+)/); if (!m) return false; return !(UUID_TX.test(m[1]) || /^agent-[0-9a-f]+\.jsonl$/i.test(m[1])); };

  // ---------- perf.log ----------
  const perf = [];
  for (const l of readLines(PERF)) { try { const r = JSON.parse(l); if (r && typeof r.ms === 'number' && !tooOldTs(r.ts)) perf.push(r); } catch (_) {} }
  const byHook = {};
  for (const r of perf) (byHook[r.hook || '(unknown)'] ||= []).push(r);
  const hookStats = Object.entries(byHook).map(([hook, recs]) => {
    const ms = recs.map(r => r.ms).sort((a, b) => a - b);
    const total = ms.reduce((a, b) => a + b, 0);
    return {
      hook, count: recs.length,
      p50: num(pctile(ms, 50)), p95: num(pctile(ms, 95)), max: num(ms[ms.length - 1] || 0),
      totalMs: num(total),
      emitted: recs.filter(r => r.emitted).length,
      blocked: recs.filter(r => r.blocked).length,
    };
  }).sort((a, b) => b.totalMs - a.totalMs);
  const perfSpan = perf.length ? { from: perf[0].ts, to: perf[perf.length - 1].ts } : null;
  const dispatchMix = { 'in-process': 0, spawn: 0, error: 0, legacy: 0 };
  for (const r of perf) { const d = r.dispatch; if (d === 'in-process') dispatchMix['in-process']++; else if (d === 'spawn') dispatchMix.spawn++; else if (d === 'error') dispatchMix.error++; else dispatchMix.legacy++; }

  // ---------- hook-audit.log (gate decisions) ----------
  const audit = readLines(AUDIT);
  let allow = 0, block = 0, settled = 0, unsettled = 0;
  // Split by EVENT. Averaging Stop with SubagentStop produced a headline that misattributed a
  // subagent-transcript limitation to the whole gate: measured 2026-08-03, main-agent Stop was
  // 960 settled / 8 unsettled (0.8%) while SubagentStop was 16 / 270 (94%). Reported as one number
  // that reads "the gate is broken", when main-agent enforcement is in fact healthy and the
  // subagent half is limited by transcripts that arrive late or never.
  let settledMain = 0, unsettledMain = 0, settledSub = 0, unsettledSub = 0;
  let failOpenSub = 0;
  const allowReasons = {}, diagEvents = {};
  const normAllow = (s) => {
    s = s.trim();
    let m;
    if (/no file mutation/.test(s)) return 'exempt: no mutation';
    if (/no completion claim/.test(s)) return 'exempt: no claim in tail';
    if (/no assistant activity/.test(s)) return 'exempt: no activity';
    if (/circuit breaker/.test(s)) return 'circuit-breaker (2nd stop)';
    if ((m = s.match(/verified \(([^)]+)\)/))) return 'verified: ' + m[1];
    if (/no transcript|unreadable|empty transcript|unparsable|fail-open/.test(s)) return 'fail-open: ' + s.slice(0, 30);
    return s.slice(0, 40);
  };
  for (const line of audit) {
    if (tooOldTs(lineTs(line)) || isFixtureLine(line)) continue; // recency window + drop test-fixture noise
    let m;
    if ((m = line.match(/\[proof-gate\] ALLOW:\s*(.*)$/))) { allow++; const r = normAllow(m[1]); allowReasons[r] = (allowReasons[r] || 0) + 1; }
    else if (/\[proof-gate\] BLOCK:/.test(line)) block++;
    if (/read settled/.test(line)) settled++;
    if (/UNSETTLED/.test(line)) unsettled++;
    // The per-event split must come from the DIAG line: it is the only record carrying BOTH the
    // event and the settled state. The `read settled` / `read UNSETTLED` lines carry neither, so
    // keying the split off them classified every read as main-agent.
    let d;
    if ((d = line.match(/DIAG event=(\S+)[^\n]*\bsettled=(true|false)/))) {
      const sub = d[1] === 'SubagentStop';
      if (d[2] === 'true') { if (sub) settledSub++; else settledMain++; }
      else if (sub) unsettledSub++; else unsettledMain++;
    }
    if ((m = line.match(/DIAG event=(\S+)/))) diagEvents[m[1]] = (diagEvents[m[1]] || 0) + 1;
  }
  const decisions = allow + block;
  const blockRate = decisions ? block / decisions : 0;

  // ---------- suggestions (severity-tagged; texts unchanged from the original report) ----------
  const suggestions = [];
  const add = (severity, text) => suggestions.push({ severity, text });
  const gate = hookStats.find(x => x.hook === 'block-unverified-completion');
  if (!perf.length && !audit.length) {
    add('info', 'No data yet. Activate godmode (create ~/.claude/godmode-active) and use it for a few turns, then re-run.');
  } else {
    if (dispatchMix.error > 0) {
      add('high', `RELIABILITY: ${dispatchMix.error} event(s) dispatched in-process but THREW and failed open (dispatch="error") — on those turns the hook emitted nothing, so the gate did NOT enforce / nothing was injected. Investigate: run the offending hook directly to surface the exception.`);
    }
    if (dispatchMix.legacy && !dispatchMix['in-process'] && !dispatchMix.spawn) {
      add('medium', `Each ACTIVE hook event spawns node TWICE (wrapper + real hook). Across ${perf.length} logged event(s) that fixed double-spawn cost is the largest avoidable overhead — an in-process dispatch (import the hook instead of execFileSync) would remove ~one node-startup per event.`);
    } else if (dispatchMix.spawn > 0) {
      add('high', `${dispatchMix.spawn} event(s) used the spawn FALLBACK (dispatch="spawn") — a hook didn't export an in-process runner (stale/partial install). Re-run the installer so every hook dispatches in-process (no 2nd node per event).`);
    }
    if (gate && gate.p95 > 800) {
      // Was: a hardcoded single cause ("that points at the flush-race retry budget"). It printed that next to
      // a max the budget arithmetically CANNOT produce, so the report contradicted itself. Attribute from the
      // measurement instead: FLUSH_CEIL is the most the retry loop can add (maxAttempts × sleep), so a max
      // above it proves a second cause is in play.
      const FLUSH_CEIL = 8 * 150;
      add('medium', `Gate p95 latency is ${gate.p95}ms (max ${gate.max}ms). ` +
        (gate.max > FLUSH_CEIL
          ? `The slowest run EXCEEDS the flush-race retry ceiling (${FLUSH_CEIL}ms = 8×150ms), so the wait alone cannot account for it — look for a SECOND cause (transcript size / full-file re-reads / a spawn-dispatch node startup) before tuning the retry count. `
          : `That is inside the flush-race retry ceiling (${FLUSH_CEIL}ms = 8×150ms), so the retry budget is a plausible cause. `) +
        (unsettled ? `${unsettled} run(s) hit UNSETTLED (budget expired).` : 'No UNSETTLED runs, so the budget is rarely exhausted — you may be able to shorten it.'));
    }
    if (unsettled > 0) {
      const pct = (n, d) => (d ? ((n / d) * 100).toFixed(0) + '%' : 'n/a');
      const mainTot = settledMain + unsettledMain, subTot = settledSub + unsettledSub;
      add('medium',
        `Flush race, BY EVENT (a combined figure misattributes this): ` +
        `main-agent Stop ${unsettledMain}/${mainTot} unsettled (${pct(unsettledMain, mainTot)}) — ` +
        `SubagentStop ${unsettledSub}/${subTot} (${pct(unsettledSub, subTot)}). ` +
        (unsettledMain / (mainTot || 1) < 0.05
          ? `Main-agent enforcement is healthy; raising the ~1.2s budget would tax every turn to fix a population that is not the problem. `
          : `Main-agent reads are genuinely racing the flush — that IS worth a longer budget. `) +
        `Subagent transcripts arrive late or never, so SubagentStop enforcement is structurally unreliable; the PARENT's Stop gate is the real backstop (it treats Task/Workflow as mutation-equivalent since 2026-08-02).`);
    }
    if (decisions >= 10 && blockRate > 0.25) {
      add('medium', `Block rate is ${(blockRate * 100).toFixed(0)}% (${block}/${decisions}). If many of these are turns you felt DID verify, the claim/evidence patterns may be over-firing — review the BLOCK lines in hook-audit.log and loosen a pattern.`);
    }
    if (decisions >= 10 && block === 0) {
      add('low', `The gate has never blocked in ${decisions} decisions — either the contract is steering well (good) or the gate is too lenient. Spot-check a turn you know wasn't verified to confirm it would bounce.`);
    }
    const drift = hookStats.find(x => x.hook === 'inject-anti-drift');
    if (drift && drift.count >= 10) {
      add('low', `anti-drift fired ${drift.count}× (it injects on every prompt). That's a recurring per-turn token tax; if drift isn't a problem in practice, consider injecting it less often (e.g., only after compaction).`);
    }
    // FAIL-OPENs are the layer's blind spot and had NO rule at all: normAllow buckets every "allowed without
    // judging" reason under a 'fail-open: …' key (no transcript / unreadable / empty / subagent transcript not
    // found), and on a real 14-day log those were 26% of all decisions. A turn that fail-opens is enforced by
    // nothing, so it must be surfaced rather than blending into the ALLOW count.
    const failOpen = Object.keys(allowReasons).filter(r => /^fail-open/.test(r)).reduce((n, r) => n + allowReasons[r], 0);
    if (decisions >= 10 && failOpen / decisions > 0.15) {
      const top = Object.keys(allowReasons).filter(r => /^fail-open/.test(r)).sort((a, b) => allowReasons[b] - allowReasons[a]).slice(0, 3)
        .map(r => `${r} ×${allowReasons[r]}`).join('; ');
      // Derive the subagent share from the SAME population as failOpen (the ALLOW-reason buckets).
      // Counting it from DIAG lines instead mixed two different record types and produced 167%.
      failOpenSub = Object.keys(allowReasons)
        .filter((r) => /^fail-open/.test(r) && /subagent transcript/.test(r))
        .reduce((n, r) => n + allowReasons[r], 0);
      const subShare = failOpen ? failOpenSub / failOpen : 0;
      add(subShare > 0.8 ? 'medium' : 'high',
        `${failOpen} of ${decisions} decisions (${(failOpen / decisions * 100).toFixed(0)}%) failed open. ` +
        (subShare > 0.8
          ? `BUT ${(subShare * 100).toFixed(0)}% of those are "subagent transcript not found" — investigated 2026-08-03: those transcripts are genuinely never written (searched every project tree; sampled ids from minutes earlier existed nowhere), so there is nothing to read and fail-open is the only possible behaviour. Delegated work is instead gated at the PARENT's Stop. Do not read this as "a third of turns are unenforced".`
          : `Top reasons: ${top}. Check the DIAG lines in hook-audit.log (they log the probed paths + existsSync).`));
    }
    const verifiedReadOnly = allowReasons['verified: re-read of written path'] || 0;
    const verifiedTest = (allowReasons['verified: test/verify command ran'] || 0);
    if (verifiedReadOnly && verifiedTest === 0 && verifiedReadOnly >= 5) {
      add('medium', `Verifications are clearing almost entirely via re-reads (${verifiedReadOnly}) and never via test/build commands. Re-reading proves the edit landed, not that it works — consider nudging toward running tests for code changes.`);
    }
  }

  return {
    perf, perfSpan, hookStats, dispatchMix,
    gate: { allow, block, blockRate: num(blockRate), settled, unsettled, allowReasons, diagEvents, decisions },
    suggestions,
  };
}

// Focused self-review for the SessionStart surfacing hook: the HIGH-SIGNAL (high|medium) items only,
// capped + terse. signal=false => nothing worth interrupting a session for (stay silent, like the rest
// of the opt-in layer). Fail-safe: returns a quiet result on any error.
function selfReview(h, opts) {
  try {
    const a = analyze(h, opts);
    const worthy = a.suggestions.filter(s => s.severity === 'high' || s.severity === 'medium');
    return {
      signal: worthy.length > 0,
      highCount: a.suggestions.filter(s => s.severity === 'high').length,
      items: worthy.slice(0, 3).map(s => s.text),
      decisions: a.gate.decisions,
    };
  } catch (_) {
    return { signal: false, highCount: 0, items: [], decisions: 0 };
  }
}

module.exports = { analyze, selfReview };
