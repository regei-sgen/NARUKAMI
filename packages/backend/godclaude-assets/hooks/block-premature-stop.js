#!/usr/bin/env node
// PERSISTENCE gate — fires on Stop (main agent) and SubagentStop (subagents).
//
// The proof-gate's MIRROR IMAGE. The proof-gate (block-unverified-completion.js) blocks ENDING A TURN
// that LIES about being done. THIS blocks ENDING A TURN that QUITS on doable work: the turn did real
// work, hit a RECOVERABLE blocker (often even named the fix), and is stopping to RECOMMEND / DEFER it
// instead of just doing it under standing approval. The "it stops, you call it out, then it acts right"
// failure — caught before you have to call it out.
//
// RETAINS godclaude's propose-don't-push CONFIRMATIONS. A turn that legitimately stops to ask for the
// user's OK on a SENSITIVE / boundary action (git push, deploy, publish, prod, secrets, destructive /
// irreversible, hand-off to godship) — or any genuine owner decision / taste call / real choice — is a
// LEGITIMATE stop and is LET THROUGH (the OWNER_GATE allowlist below). The gate fires ONLY on a give-up
// with NO such owner-gate. Calibration bias: a missed give-up is cheap (one nudge); a FALSE block of a
// real confirmation would fight godclaude's own safety design, so the allowlist is broad and wins ties.
//
// BLOCK when ALL hold:
//   (1) the turn USED TOOLS (it was actively working, not pure chat / Q&A), AND
//   (2) the closing message matches a GIVE-UP / execution-deferral pattern, AND
//   (3) it does NOT match a genuine OWNER-GATE (decision / approval / sensitive-action confirm /
//       destructive action / taste call / real choice) — those are retained, never blocked.
//
// Safety (identical contract to the proof-gate):
//   - Fail-OPEN on any error (never trap a session on a hook bug).
//   - Circuit breaker: stop_hook_active === true → ALLOW. AT MOST ONE bounce per stop; no loop.
//   - Every decision appended to ~/.claude/hook-audit.log ([persist-gate]; rotated past 10 MB → .1).
//   - Honors DET_HOOKS_HOME (tests). SubagentStop derives the subagent's own transcript (incl. workflows/).
//   - In-process decide(data) export (dispatched by godmode-gate.mjs, no second `node` spawn) + CLI shim.

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;
const MAX_AUDIT_BYTES = 10 * 1024 * 1024;

function audit(line) {
  try {
    try { const st = fs.statSync(AUDIT); if (st.size > MAX_AUDIT_BYTES) fs.renameSync(AUDIT, `${AUDIT}.1`); } catch (_) {}
    fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [persist-gate] ${line}\n`);
  } catch (_) {}
}
function allow(reason) { audit(`ALLOW: ${reason}`); return ''; }
function block(reason) { audit(`BLOCK: ${reason.slice(0, 160)}`); return JSON.stringify({ decision: 'block', reason }); }

// (3) GENUINE owner-gate → a legitimate stop. RETAINS godclaude's propose-don't-push confirmations:
// a stop that references a sensitive / boundary action needing the user's OK, OR explicit owner-decision /
// taste / real-choice language, is LET THROUGH. Broad on purpose (fails toward ALLOW).
const OWNER_GATE = [
  // explicit owner decision / approval
  /\byour (call|decision|approval|sign-?off|input|preference|consent|ok|go[- ]?ahead)\b/i,
  /\bneeds?\s+(your|the\s+owner'?s?|owner|human|user'?s?)\b/i,
  /\bawait(ing)?\s+(your|the\s+owner|owner|confirmation|approval|sign-?off|the user|you)\b/i,
  /\bup to you\b/i, /\byour move\b/i, /\bgreen[- ]?light\b/i, /\bonly you can\b/i,
  /\bexplicit\s+(in-?session\s+)?(ok|okay|confirmation|approval|consent|go-?ahead|sign-?off)\b/i,
  /\b(approve|authoriz|permission|sign\s*off)\b/i,
  // a real choice / taste call
  /\bwhich\s+(one|option|approach|direction|way|version|stack|framework|database)\b/i,
  /\b(option|approach|route)\s+[ab1-3]\b/i,
  /\b(taste|aesthetic|preference|opinion)\b/i,
  // the propose-don't-push boundary — a sensitive / outward-facing action that REQUIRES the user's OK
  /\bpropose[- ]?only\b/i, /\bpropos(e|ing|ed)\b[^.?!\n]{0,40}\b(step|command|deploy|push|change|action|plan|diff)\b/i,
  /\b(git\s+push|force[- ]?push|push\s+to\s+(git|remote|origin))\b/i,
  /\bdeploy(ing|ment)?\b/i, /\bpublish(ing)?\b/i, /\brelease\b/i, /\bgo\s+live\b/i, /\bship(ping|ped)?\s+(it|this|to)\b/i,
  /\b(prod(uction)?|staging)\b/i, /\blive\s+(infra|env|environment|site|server|database|config|cloud)\b/i,
  /\b(secret|credential|token|api[- ]?key|password|private\s+key|\.env)\b/i,
  /\b(destructive|irreversible|can'?t\s+be\s+undone|cannot\s+be\s+undone|hard\s+to\s+(reverse|undo)|unrecoverable)\b/i,
  /\bgodship\b/i, /\bhand\s*-?\s*off\b/i, /\bmerge\s+(the\s+)?(pr|pull\s+request)\b/i,
];

// (2) GIVE-UP / execution-deferral — stopped at a recoverable point with doable work pending.
const GIVEUP = [
  /\brecommend(ing)?\b[^.?!\n]{0,90}\b(before|first|prior to)\b/i,
  /\bbefore\s+(any|the)?\s*(further|next|additional|more)\s+(build|run|step|work|pass|phase|change)/i,
  /\bbefore\s+(you|we)?\s*(continue|proceed|build|run|implement|move on)\b/i,
  /\bthe fix (is|would be|here is|:|=)\b/i,
  /\b(want me to|should i|shall i|do you want me to)\b[^?\n]{0,100}\?/i,
  /\blet me know if you(?:'?d| would)?\s*(like|want|need)\b/i,
  /\b(stopping|halting|pausing)\s+(here|now|for now)\b/i,
  /\b(i'?ll|i will|i can|i could|we should)\s+(then\s+)?(fix|port|add|implement|continue|build|run|wire|finish)\b[^.?!\n]{0,60}\b(if|once|when|after)\b/i,
];

function decide(data) {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return allow('input unparsable (fail-open)'); }
  try {
    const event = input.hook_event_name || 'Stop';
    if (input.stop_hook_active === true) return allow('stop_hook_active=true (circuit breaker)');

    let tp = input.transcript_path;
    if (!tp || !fs.existsSync(tp)) return allow('no transcript path');
    const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };
    // SubagentStop hands us the MAIN transcript; derive the subagent's own (incl. workflow subagents,
    // which nest one level deeper under subagents/workflows/<run-id>/). Mirrors the proof-gate: judge the
    // SUBAGENT, never fall back to the parent's mid-turn transcript.
    const deriveSubagentTp = () => {
      if (!input.agent_id) return '';
      const base = tp.replace(/\.jsonl$/i, '');
      const direct = `${base}/subagents/agent-${input.agent_id}.jsonl`;
      if (fs.existsSync(direct)) return direct;
      try { const wf = `${base}/subagents/workflows`; for (const d of fs.readdirSync(wf)) { const c = `${wf}/${d}/agent-${input.agent_id}.jsonl`; if (fs.existsSync(c)) return c; } } catch (_) {}
      return '';
    };
    if (event === 'SubagentStop') {
      // Never judge the parent on a subagent stop: it mis-enforces AND can never settle (parent turn still
      // running) → the old fallback burned the whole flush budget. Short retry for the creation-race minority,
      // then fail OPEN explicitly (the parent's own Stop re-judges). Covers agent_id-less payloads too.
      let found = deriveSubagentTp();
      for (let r = 0; !found && r < 2; r++) { sleepSync(150); found = deriveSubagentTp(); }
      if (found) tp = found;
      else { audit(`SubagentStop: derived path not found for agent-${input.agent_id || '(no agent_id)'} → fail-open (not parent-judged)`); return allow('subagent transcript not found — cannot judge subagent (fail-open)'); }
    }

    const parseObjs = (raw) => { const a = []; for (const l of raw.split('\n')) { if (!l.trim()) continue; try { a.push(JSON.parse(l)); } catch (_) {} } return a; };
    const endsOnAsstText = (objs) => {
      for (let i = objs.length - 1; i >= 0; i--) {
        const o = objs[i];
        if (!o || (o.type !== 'assistant' && o.type !== 'user')) continue; // skip trailing meta records
        return !!(o.type === 'assistant' && o.message && Array.isArray(o.message.content) && o.message.content.some(b => b && b.type === 'text' && b.text));
      }
      return false;
    };

    // FLUSH-RACE GUARD (mirror of the proof-gate): the closing message may not be flushed yet.
    // WP-2.2 settledness lever (A8): SubagentStop gets a SHORTER budget (2×150ms vs 8×). A subagent
    // transcript very often legitimately ends on a tool_result (no closing assistant text is coming), so
    // endsOnAsstText can never become true and the full 8×150ms was burned for nothing — and a subagent
    // with no closing text has no give-up to catch (it exits at "no closing message" below anyway). A
    // pure-chat / already-settled turn still breaks on the first read regardless of the cap.
    let objs = [], settled = false, lastSize = -1;
    const maxAttempts = event === 'SubagentStop' ? 2 : 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let size = -1;
      try { size = fs.statSync(tp).size; } catch (_) {}
      if (size !== lastSize || !objs.length) {
        let raw = '';
        try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return allow('transcript unreadable'); }
        objs = parseObjs(raw);
        lastSize = size;
        if (objs.length && endsOnAsstText(objs)) { settled = true; break; }
      }
      sleepSync(150);
    }
    if (!objs.length) return allow('empty transcript');

    // Start of current turn = after the last genuine user prompt (not a tool_result).
    let startIdx = 0;
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (o.type === 'user') {
        const c = o.message && o.message.content;
        const isToolResult = Array.isArray(c) && c.some(b => b && b.type === 'tool_result');
        const isText = typeof c === 'string' || (Array.isArray(c) && c.some(b => b && b.type === 'text'));
        if (isText && !isToolResult) { startIdx = i; break; }
      }
    }
    const turn = objs.slice(startIdx);

    const toolUses = [];
    let lastText = '';
    for (const o of turn) {
      if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
      for (const b of o.message.content) {
        if (b.type === 'text' && b.text) lastText = b.text; // last assistant text = closing message
        if (b.type === 'tool_use') toolUses.push({ name: b.name });
      }
    }

    // (1) active WORK turn? (used tools) — pure chat / Q&A is exempt (not our domain).
    if (!toolUses.length) return allow('no tool use this turn (pure chat/Q&A — exempt)');

    const tail = (lastText || '').slice(-1500);
    if (!tail.trim()) return allow('no closing message');

    // (3) RETAIN confirmations: a genuine owner-gate → legitimate stop, let it through.
    const owner = OWNER_GATE.find(p => p.test(tail));
    if (owner) return allow(`genuine owner-gate / confirmation in closing message (${owner})`);

    // (2) GIVE-UP / execution-deferral with NO owner-gate → premature stop on doable work.
    const giveup = GIVEUP.find(p => p.test(tail));
    if (!giveup) return allow('no give-up / execution-deferral pattern in closing message');

    audit(`DIAG event=${event} settled=${settled} tools=${toolUses.length} giveup=${giveup} tail=${JSON.stringify(tail.slice(-90))}`);
    return block(
      `Persistence gate (${event}): you used tools this turn and are stopping with WORK STILL PENDING — your ` +
      `closing message matched a give-up / "recommend-it-instead-of-doing-it" pattern (${giveup}) and there is NO ` +
      `genuine owner-gate (a real decision, an approval, a sensitive/boundary action, a destructive action, or a ` +
      `taste call) in it.\n\n` +
      `Per the Deterministic Operating Contract rule 5 (stick to the plan) and the standing job (finish the work — ` +
      `don't file a report and halt): you have approval and a RECOVERABLE blocker. Do ONE of:\n` +
      `  - DO the next step you just named and CONTINUE the work — don't stop to recommend it, OR\n` +
      `  - If you are genuinely waiting on the USER, REWRITE your closing message to say so PLAINLY, in LAYMAN'S ` +
      `TERMS — name (a) exactly WHAT you need them to confirm or decide, (b) WHY it needs their OK in everyday ` +
      `words (e.g. "this can't be undone", "this goes live/public", "this touches passwords/secrets or production", ` +
      `or "this is a taste call"), and (c) the concrete options. A sensitive action (git push / deploy / publish / ` +
      `prod / secrets / anything destructive) ALWAYS counts as a real owner-gate — just say so clearly and it passes.\n\n` +
      `This is one bounce (the circuit breaker allows the next stop), so make it count: continue the work, or state ` +
      `the genuine blocker in plain language.`
    );
  } catch (err) {
    return allow(`unexpected error (fail-open): ${err && err.message}`);
  }
}

// In-process entrypoint: godmode-gate.mjs requires this module and calls decide(data) directly.
module.exports = decide;

// CLI entrypoint — identical observable behavior to before (read stdin, decide, emit any block JSON, exit 0).
if (require.main === module) {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => { let out = ''; try { out = decide(data); } catch (_) { out = ''; } if (out) process.stdout.write(out); process.exit(0); });
}
