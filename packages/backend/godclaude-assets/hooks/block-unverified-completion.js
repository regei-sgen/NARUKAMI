#!/usr/bin/env node
// GENERAL proof-of-work gate — fires on Stop (main agent) and SubagentStop (subagents).
//
// Blocks ENDING A TURN that (1) mutated files AND (2) asserts completion/success in the
// closing message AND (3) shows NO *post-mutation* verification this turn. This is the
// deterministic answer to "it edits something, says 'done/fixed/works', and ends without
// ever proving it."
//
// What clears the gate (any one) — and it must occur AFTER the last file mutation in the turn,
// so it proves the CHANGE, not the original code:
//   - a Read (or cat/type/Get-Content/head/tail) of a path written this turn   → re-read
//   - a Bash/PowerShell command matching test/build/lint/curl/diff/verify       → test ran
//   - a text "evidence marker" in the closing message (Evidence:/Test output:/Verified-via:/
//     exit 0/N passed/HTTP 200/$ shell-prompt) — BUT ONLY IF a real Bash/PowerShell command
//     actually ran after the last mutation this turn. A marker typed as prose with nothing
//     behind it does NOT count: that fabricated "proof" is exactly the fake-finish this gate exists
//     to stop. (Bare fenced code blocks have never counted; this closes the prose-marker hole too.)
//
// Non-mutating turns (pure Q&A / research / read-only) are STRUCTURALLY EXEMPT.
//
// Safety:
//   - Fail-OPEN on any error (never trap a session on a hook bug).
//   - Circuit breaker: stop_hook_active === true → ALLOW. Guarantees AT MOST ONE hard
//     bounce per stop; no infinite loop. (Tradeoff: a determined no-op could stop twice.)
//   - Every decision appended to ~/.claude/hook-audit.log (auto-rotated past 10 MB → .1).

'use strict';
const fs = require('node:fs');
const os = require('node:os');
// Shared mode resolver (fail-safe: returns 'general' / {} on any problem => base behavior).
// The require itself is guarded: if godmode-mode.js is missing/corrupt (e.g. a partial install),
// degrade to general/base inline rather than throwing at load — so the gate stays fail-SAFE on its
// own, not only because the opt-in wrapper happens to swallow a crash.
let resolveMode, resolveModes, loadGateConfig, combineGateConfigs, canonicalMode, readModeAsset, STATE;
try { ({ resolveMode, resolveModes, loadGateConfig, combineGateConfigs, canonicalMode, readModeAsset, STATE } = require('./godmode-mode.js')); }
catch (_) {}
// Fail-safe shims if the resolver is missing/corrupt (partial install) — degrade to general/base.
if (typeof resolveModes !== 'function') resolveModes = () => ['general'];
if (typeof resolveMode !== 'function') resolveMode = () => 'general';
if (typeof loadGateConfig !== 'function') loadGateConfig = () => ({});
if (typeof combineGateConfigs !== 'function') combineGateConfigs = (h, modes) => { try { return loadGateConfig(h, (Array.isArray(modes) ? modes : [modes])[0]); } catch (_) { return {}; } };
if (typeof canonicalMode !== 'function') canonicalMode = (x) => String(x || '').trim().toLowerCase();
if (typeof readModeAsset !== 'function') readModeAsset = () => '';
// DET_HOOKS_HOME lets the installer self-check / tests redirect the audit log into a sandbox;
// unset in normal use → real home. Only affects where hook-audit.log is written.
const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;
const MAX_AUDIT_BYTES = 10 * 1024 * 1024; // rotate the audit log past 10 MB (keep one .1 backup)

// --- pattern sets (module scope: built once per process, not per decision) ---
const MUT = new Set(['Write', 'Edit', 'NotebookEdit']); // tool-level mutations we gate on
const SHELL = new Set(['Bash', 'PowerShell']);          // tools that can run real commands
const CLAIM = [
  /\b(all\s+)?done\b/i, /\ball set\b/i, /\bcomplete(d)?\b/i, /\bfinished\b/i,
  /\bfixed\b/i, /\bresolved\b/i, /\bverified\b/i, /\bconfirmed\b/i, /\bvalidated\b/i,
  /\b(it\s+)?works\b/i, /\bworking\b/i, /\bready\b/i, /\bpass(es|ing)?\b/i,
  /\bsuccessfully\b/i, /\bshould\s+(now\s+)?(work|be fixed|pass)\b/i, /\bimplemented\b/i
];
// WP-1.3: dropped bare `\bdiff\b` (a `git diff`/`diff` merely DISPLAYS your own edit — it exercises nothing,
// so it must not count as verification) and required `curl` to carry an argument (`\bcurl\s+\S+` — a bare
// `curl` token in prose can't clear; a real request to a URL/localhost can).
const TEST_CMD = /\b(npm|pnpm|yarn)\s+(run\s+)?(test|build|lint|typecheck)\b|\b(pytest|jest|vitest|mocha|playwright|tsc)\b|\bcargo\s+(test|build|check)\b|\bgo\s+test\b|\bcurl\s+\S+|node\b[^\n]*\b(test|verify|check|assert)\b|\.test\.|\.spec\./i;
const FILE_READ_CMD = /\b(cat|type|Get-Content|head|tail)\b/i; // shell ways to re-read a file
// SHELL MUTATIONS (WP-1.2): Bash/PowerShell commands that mutate the filesystem/repo but produce NO
// re-readable artifact the way Write/Edit do (rm, mv, git commit, npm install, redirects, Set-Content…).
// Without this, a turn whose ONLY work is a shell mutation ("git commit" + "done") counted as exempt and
// escaped the gate. SEGMENT-AWARE + quote-stripped so a mutating verb as a substring or inside a quoted
// arg never false-fires (`git log --format=%H`, `awk '$3 > 100'`, `git log --grep "git commit"`,
// `ls 2>/dev/null` all stay read-only). Deliberately TIGHT (no echo/reads) — a false positive here BLOCKS
// legitimate work, so we err toward missing an exotic mutation over blocking a benign command.
const SHELL_MUT_HEAD = /^(?:sudo\s+)?(?:\w+=\S+\s+)*(rm|rmdir|mv|cp|dd|truncate|ln|chmod|chown|tee|touch|mkdir|sed\s+-i|perl\s+-i|npm\s+(?:i\b|install|uninstall|ci|prune|rebuild)|pnpm\s+(?:add|install|remove)|yarn\s+(?:add|remove|install)|pip3?\s+(?:install|uninstall)|cargo\s+(?:install|add|rm)|go\s+(?:get|install)|git\s+(?:commit|merge|rebase|reset|checkout|restore|apply|am|cherry-pick|clean|rm|mv|tag)|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content)\b/i;
function isShellMutation(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""'); // drop quoted regions
  for (const seg of stripped.split(/\|\||&&|[;&|\n]/)) if (SHELL_MUT_HEAD.test(seg.trim())) return true;
  // unquoted file redirect (> / >>) to a REAL target — after removing fd-dups (2>&1) and any /dev/null redirect
  const r = stripped.replace(/\d?>>?\s*\/dev\/null/gi, ' ').replace(/\d?>>?\s*&\s*\d?/g, ' ');
  return /[^0-9&|]\s*>>?\s*[^\s>&|]/.test(' ' + r);
}
// Text evidence markers. These ONLY count when a real command ran post-mutation (see decision logic).
const EV = [/\bevidence:/i, /\btest output:/i, /\bverified[- ]via:/i, /\bexit(\s+code)?:?\s*0\b/i, /\b\d+\s+(passed|passing)\b/i, /HTTP\/[12][^\n]*\b200\b/i, /^\s*\$\s+\S/m];
// FAILURE signature for a verification command's RESULT. A test/build that VISIBLY FAILED is not proof of a
// fix — running a red test then claiming "done" is the exact fake-finish this gate exists to stop. We consult
// the command's tool_result: a tool-level is_error (Claude Code sets it on a non-zero exit), or a tight failure
// marker in the output. Kept HIGH-PRECISION (no bare "fail"/"error" words; "[1-9]+ failed" never matches the
// benign "0 failed") so a passing run is never mislabeled. No locatable result ⇒ fail-OPEN (treat as passed).
const FAILSIG = /Traceback \(most recent call last\)|\bAssertionError\b|\bnpm ERR!|\bELIFECYCLE\b|\bpanic:|\bBUILD FAILED\b|\bFAILED\b|\b[1-9]\d*\s+(?:failed|failing|errors?)\b|\bexit(?:\s+code)?\s*[1-9]\d*\b|✗/;
// NEGATION guard for completion claims. A claim word sitting right after a negator ("still not working",
// "doesn't pass", "no longer works", "not done yet", "unable to verify") is an HONEST NEGATIVE — the message
// is already stating what is unverified, which is exactly what the gate asks for, so it must NOT be read as a
// claim. The window is short (negator immediately before the word, across ≤2 hedging adverbs) so "not only
// does it work, it's fast" — where the negator attaches elsewhere — still trips the gate.
const NEG = /(?:\bnot\b|\bno\s+longer\b|\bnever\b|\bcannot\b|\bcan'?t\b|\bwon'?t\b|\bisn'?t\b|\baren'?t\b|\bwasn'?t\b|\bweren'?t\b|\bdoesn'?t\b|\bdon'?t\b|\bdidn'?t\b|\bhasn'?t\b|\bhaven'?t\b|\bwouldn'?t\b|\bcouldn'?t\b|\bshouldn'?t\b|\bunverified\b|\bunconfirmed\b|\buntested\b|\bfails?\s+to\b|\bfailing\s+to\b|\bunable\s+to\b)\s+(?:yet\s+|quite\s+|fully\s+|currently\s+|really\s+|actually\s+|even\s+|still\s+|consistently\s+|always\s+|properly\s+|completely\s+|reliably\s+|necessarily\s+){0,2}$/i;

// --- per-mode overrides (ADDITIVE; 'general' => none => base behavior is byte-for-byte unchanged) ---
// A mode's gate.json may add claim words and accepted proofs, register verification TOOL NAMES
// (MCP / WebSearch), and — via reReadClears:false — REQUIRE a real command instead of a bare
// re-read. A mode can only widen the accepted-proof set or tighten it; it can never drop the gate
// below the general floor. Every read is fail-safe: a miss/parse error => no override => base gate.
function compileList(arr) {
  const out = [];
  if (Array.isArray(arr)) for (const src of arr) { try { out.push(new RegExp(String(src), 'i')); } catch (_) {} }
  return out;
}
// NOTE: the ACTIVE mode (and therefore the effective pattern sets) is resolved INSIDE the stdin
// handler, not here — it depends on input.cwd so a path-gated mode (one shipping scope.json) only applies
// its overrides inside its scoped dir. See the `resolveMode(HOME, input.cwd)` call below.

function audit(line) {
  try {
    // Rotate before append so a runaway session can't grow the log without bound.
    try { const st = fs.statSync(AUDIT); if (st.size > MAX_AUDIT_BYTES) fs.renameSync(AUDIT, `${AUDIT}.1`); } catch (_) {}
    fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [proof-gate] ${line}\n`);
  } catch (_) {}
}
// allow/block now RETURN the gate's output ('' = allow / nothing to emit; the block JSON = block)
// instead of writing-and-exiting, so the whole decision can run IN-PROCESS inside godmode-gate.mjs
// (no second `node` spawn) as well as via the CLI shim at the bottom. Every call site is already
// `return allow(...)` / `return block(...)`, so the control flow is byte-for-byte unchanged.
function allow(reason) { audit(`ALLOW: ${reason}`); return ''; }
function block(reason) { audit(`BLOCK: ${reason.slice(0, 160)}`); return JSON.stringify({ decision: 'block', reason }); }

// Does `cmd` reference `basename` as a WHOLE filename token (not a longer name that merely
// contains it)? Guards against e.g. `cat thing.js.bak` falsely "verifying" a written `thing.js`.
// A boundary is anything that is NOT a filename-ish char ([\w.-]); path separators, quotes,
// spaces, and string ends all qualify. So `cat thing.js`, `cat path/thing.js`, `cat thing.js;`
// match `thing.js`, but `cat thing.js.bak`, `cat thing.jsx`, `cat mything.js` do not.
function cmdReadsFile(cmd, basename) {
  if (!basename) return false;
  const isNameChar = (c) => /[\w.\-]/.test(c || '');
  let i = cmd.indexOf(basename);
  while (i !== -1) {
    const before = i === 0 ? '' : cmd[i - 1];
    const after = cmd[i + basename.length] || '';
    if (!isNameChar(before) && !isNameChar(after)) return true;
    i = cmd.indexOf(basename, i + 1);
  }
  return false;
}
// Is the Read'd path `fp` the SAME file as a written path `w`? Exact match (the normal case — Claude Code
// Read uses absolute paths), OR one is the other with a path-boundary prefix (tolerates relative-vs-absolute
// forms like `work/a.js` vs `C:/work/a.js`). Crucially NOT a loose substring: re-reading a SUPERSTRING-named
// file (a.js.bak / a.js.old / a.js~) must NOT clear a claim about the file actually written (a.js) — the old
// bidirectional includes did, inconsistent with the shell-cat token-boundary guard (cmdReadsFile).
function samePath(fp, w) {
  if (!fp || !w) return false;
  if (fp === w) return true;
  const [lo, sh] = fp.length >= w.length ? [fp, w] : [w, fp];
  return lo.endsWith('/' + sh); // boundary suffix only — never a bare substring
}

// True iff `re` has at least one match in `text` that is NOT immediately preceded by a negator (NEG). Lets an
// honest-negative closing message ("it's still not working, the tests don't pass") through, while any genuine
// un-negated claim word in the same message still counts as a completion claim.
function matchesUnnegated(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!NEG.test(before)) return true;
    if (m.index === g.lastIndex) g.lastIndex++; // guard against a zero-width match looping forever
  }
  return false;
}

// Decide synchronously and RETURN the output string. All work below is synchronous (sync fs reads +
// Atomics.wait sleep), so godmode-gate.mjs can dispatch the gate in-process by simply calling decide(data).
function decide(data) {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return allow('input unparsable (fail-open)'); }
  try {
    const event = input.hook_event_name || 'Stop';
    if (input.stop_hook_active === true) return allow('stop_hook_active=true (circuit breaker)');

    // Resolve the active mode SET for THIS session (input.session_id isolates it from other sessions;
    // input.cwd path-gates any scoped mode). A session can run MULTIPLE modes at once — the effective
    // gate config is the combined (union of proofs/claims, strictest reReadClears) of all active modes.
    // For a single mode this is byte-for-byte the old single-mode gate.
    let MODES = (() => { try { return resolveModes(HOME, input.cwd, input.session_id); } catch (_) { return ['general']; } })();
    // SUBAGENT MODE DELEGATION: on SubagentStop, if the parent set a `subagent-mode`, gate the SUBAGENT's
    // claims under THAT mode (matching the contract injected at SubagentStart) — so a delegated sub-task is
    // held to the sub-mode's proof standard, not the parent's. Main-agent Stop is unaffected. Fail-safe.
    if (event === 'SubagentStop' && STATE && typeof STATE.readState === 'function') {
      try {
        const raw = (STATE.readState(HOME, input.session_id, 'subagent-mode') || '').trim();
        const c = raw ? canonicalMode(raw) : '';
        // Same adoption guard as SubagentStart (inject-deterministic-contract.js): only gate under the
        // sub-mode if its contract.md actually loads — so for a half-broken mode the gate falls back to
        // the parent (matching the contract the subagent was given), never gate=sub while contract=parent.
        if (c && c !== 'general' && readModeAsset(HOME, c, 'contract.md').trim()) MODES = [c];
      } catch (_) {}
    }
    const MODE = MODES[0] || 'general';
    const MODELABEL = MODES.filter(m => m && m !== 'general').join('+') || 'general';
    const OV = (() => { try { return combineGateConfigs(HOME, MODES); } catch (_) { return {}; } })();
    const CLAIM_EFF = CLAIM.concat(compileList(OV.extraClaim));           // claim words: base UNION mode
    const TESTCMD_EFF = [TEST_CMD, ...compileList(OV.extraTestCmd)];      // verify-commands: test with .some()
    const FILEREAD_EFF = [FILE_READ_CMD, ...compileList(OV.extraFileReadCmd)];
    const EV_EFF = EV.concat(compileList(OV.extraEvidence));             // evidence markers: base UNION mode
    const VERIFY_TOOLS = compileList(OV.extraVerifyTools);               // tool NAMES that count as proof (MCP/WebSearch)
    const RE_READ_CLEARS = OV.reReadClears !== false;                    // default true; false => a bare re-read is NOT proof
    const someTest = (cmd) => TESTCMD_EFF.some(r => r.test(cmd));
    const someFileRead = (cmd) => FILEREAD_EFF.some(r => r.test(cmd));

    let tp = input.transcript_path;
    if (!tp || !fs.existsSync(tp)) return allow('no transcript path');
    const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };
    // EMPIRICAL (2026-06-01): SubagentStop hands us the MAIN session transcript_path, NOT the subagent's.
    // The subagent's own transcript lives at <main-transcript-without-.jsonl>/subagents/agent-<agent_id>.jsonl
    // (workflow-spawned subagents nest one level DEEPER, under subagents/workflows/<run-id>/). Derive it so
    // we judge the SUBAGENT's closing message, not the parent's still-running turn.
    const deriveSubagentTp = () => {
      if (!input.agent_id) return '';
      const base = tp.replace(/\.jsonl$/i, '');
      const direct = `${base}/subagents/agent-${input.agent_id}.jsonl`;
      if (fs.existsSync(direct)) return direct;
      try {
        const wf = `${base}/subagents/workflows`;
        for (const d of fs.readdirSync(wf)) {
          const c = `${wf}/${d}/agent-${input.agent_id}.jsonl`;
          if (fs.existsSync(c)) return c;
        }
      } catch (_) {}
      return '';
    };
    if (event === 'SubagentStop') {
      // Judge the SUBAGENT, never the parent. If derivation fails we do NOT fall back to the parent's
      // mid-turn transcript — that mis-enforces (blocks the subagent on the parent's unfinished state) AND
      // can never settle (the parent turn is still running), so the old fallback burned the whole ~1.2s flush
      // budget for nothing. A short retry rides out the creation-race minority (the subagent transcript is
      // written a beat after SubagentStop fires); if it still isn't on disk, fail OPEN explicitly — the
      // subagent's claim goes un-gated HERE, but the parent's own Stop gate re-judges the whole turn. Also
      // covers agent_id-less SubagentStop payloads (deriveSubagentTp → '' → never parent-judged).
      let found = deriveSubagentTp();
      for (let r = 0; !found && r < 2; r++) { sleepSync(150); found = deriveSubagentTp(); }
      if (found) tp = found;
      else { audit(`DIAG event=SubagentStop mode=${MODELABEL} derived path not found for agent-${input.agent_id || '(no agent_id)'} → fail-open (not parent-judged)`); return allow('subagent transcript not found — cannot judge subagent (fail-open)'); }
    }

    const parseObjs = (raw) => { const a = []; for (const l of raw.split('\n')) { if (!l.trim()) continue; try { a.push(JSON.parse(l)); } catch (_) {} } return a; };
    // "Has the closing assistant message been flushed yet?" Scan from the end but SKIP trailing
    // NON-conversational records (system / queue / permission / file / attachment / pr / bridge) that
    // Claude Code appends AFTER the closing message. EMPIRICAL (2026-06, real audit log): these trailing
    // records accounted for ~all UNSETTLED reads — the closing text was already present, but the old
    // "is the LAST LINE assistant text?" check couldn't see past them, so it burned the entire flush
    // budget (~1.2s) for nothing and mislabeled the turn under-enforced. Settled iff the last
    // conversational (user/assistant) line is assistant text; a trailing tool_result (type 'user', the
    // genuine flush-race shape where the final text isn't written yet) still reads as NOT settled → wait.
    const endsOnAsstText = (objs) => {
      for (let i = objs.length - 1; i >= 0; i--) {
        const o = objs[i];
        if (!o || (o.type !== 'assistant' && o.type !== 'user')) continue; // skip trailing meta records
        return !!(o.type === 'assistant' && o.message && Array.isArray(o.message.content) && o.message.content.some(b => b && b.type === 'text' && b.text));
      }
      return false;
    };

    // FAST PATH (flush-race latency fix): read the transcript ONCE and check for a file mutation BEFORE
    // paying the flush-race wait. Mutations + tool_results are reliably flushed by Stop time — only the
    // closing TEXT races — and a turn with NO file mutation is EXEMPT no matter what its closing text says.
    // So waiting for a flush a no-mutation turn doesn't need is pure wasted latency: empirically ~70% of
    // UNSETTLED reads on real logs were muts=0, each burning the full ~1.2s budget for nothing. Only when a
    // mutation IS present do we enter the flush loop below to capture the (still-racing) completion claim.
    let objs = [], settled = false, lastSize = -1;
    {
      let raw0 = '';
      try { raw0 = fs.readFileSync(tp, 'utf8'); } catch (_) { return allow('transcript unreadable'); }
      const o0 = parseObjs(raw0);
      if (!o0.length) return allow('empty transcript');
      // turn-start (last genuine user prompt, not a tool_result), then scan the turn for any mutation tool_use
      let s0 = 0;
      for (let i = o0.length - 1; i >= 0; i--) {
        const o = o0[i];
        if (o.type === 'user') {
          const c = o.message && o.message.content;
          const isTR = Array.isArray(c) && c.some(b => b && b.type === 'tool_result');
          const isText = typeof c === 'string' || (Array.isArray(c) && c.some(b => b && b.type === 'text'));
          if (isText && !isTR) { s0 = i; break; }
        }
      }
      let mut0 = false;
      for (const o of o0.slice(s0)) {
        if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
          for (const b of o.message.content) if (b && b.type === 'tool_use' && (MUT.has(b.name) || (SHELL.has(b.name) && isShellMutation(b.input && b.input.command)))) { mut0 = true; break; }
        }
        if (mut0) break;
      }
      if (!mut0) { audit(`DIAG event=${event} mode=${MODELABEL} fast-exit (no mutation → exempt; no flush wait) tx=${tp.split(/[\\/]/).pop()}`); return allow('no file mutation this turn (exempt) [fast-path, no flush wait]'); }
      objs = o0; // mutation present → seed the flush loop with what we already read
    }

    // FLUSH-RACE GUARD: at Stop/SubagentStop time the FINAL assistant text (the closing
    // message that carries the completion claim) may not be flushed to the transcript yet.
    // Re-read until the transcript ends on an assistant-text message, or the budget expires.
    // Optimization: skip the (potentially MB-sized) re-read+parse on attempts where the file
    // size hasn't changed — nothing was flushed, so the parse would be identical.
    // WP-2.2 (A8 settledness): SubagentStop gets a shorter flush budget (2×150ms vs 8×). A derived subagent
    // transcript that ends on a tool_result has no closing CLAIM to catch (it exits at "no completion claim"),
    // so the full 8× wait was wasted; a real racing claim still lands within the shorter window or is judged
    // on the parent's own Stop. The main-agent Stop keeps the full budget where the closing claim reliably comes.
    const maxAttempts = event === 'SubagentStop' ? 2 : 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let size = -1;
      try { size = fs.statSync(tp).size; } catch (_) {}
      // Re-read when the file grew, OR while we still have nothing parsed (so a transient
      // statSync miss can never skip the one-and-only read and force a false "empty transcript").
      if (size !== lastSize || !objs.length) {
        let raw = '';
        try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return allow('transcript unreadable'); }
        objs = parseObjs(raw);
        lastSize = size;
        if (objs.length && endsOnAsstText(objs)) { settled = true; break; }
      }
      sleepSync(150); // ~max 1.2s total; well within hook timeout
    }
    if (!objs.length) return allow('empty transcript');
    audit(`read ${settled ? 'settled' : 'UNSETTLED(flush budget expired)'} lastType=${objs[objs.length - 1] && objs[objs.length - 1].type}`);

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

    // Collect tool uses IN ORDER so we can require verification to come AFTER the last mutation,
    // plus the last assistant text (the closing message).
    const toolUses = [];
    let lastText = '';
    for (const o of turn) {
      if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
      for (const b of o.message.content) {
        if (b.type === 'text' && b.text) lastText = b.text;        // last assistant text wins = closing message
        if (b.type === 'tool_use') toolUses.push({ name: b.name, input: b.input || {}, id: b.id });
      }
    }
    if (!toolUses.length && !lastText) return allow('no assistant activity in turn');

    // Map each tool_use id -> its result (is_error + text) so a verification COMMAND can be checked for
    // having actually PASSED. Built from THIS turn's tool_result records (Claude Code emits one per call,
    // referencing the tool_use_id). A result is reliably flushed by Stop time (only the closing TEXT races).
    const resultById = new Map();
    for (const o of turn) {
      if (o.type !== 'user' || !o.message || !Array.isArray(o.message.content)) continue;
      for (const b of o.message.content) {
        if (b && b.type === 'tool_result' && b.tool_use_id) {
          let txt = '';
          if (typeof b.content === 'string') txt = b.content;
          else if (Array.isArray(b.content)) txt = b.content.map(x => (x && typeof x.text === 'string') ? x.text : '').join('\n');
          resultById.set(b.tool_use_id, { is_error: b.is_error === true, text: txt });
        }
      }
    }
    // Did a verification command VISIBLY FAIL? is_error (tool-level), else a tight output failure signature.
    // No locatable result (no id / unknown shape) ⇒ fail-OPEN (not-failed), preserving the gate's
    // never-trap-the-session stance and keeping legacy/un-id'd transcripts byte-for-byte unchanged.
    const cmdFailed = (tu) => {
      if (!tu || !tu.id) return false;
      const r = resultById.get(tu.id);
      if (!r) return false;
      if (r.is_error) return true;
      return !!(r.text && FAILSIG.test(r.text));
    };

    // (1) mutation this turn? Track the LAST FILE mutation's index (Write/Edit/NotebookEdit) — the point
    // after which verification must appear (verify-of-change). SHELL mutations (rm/git commit/npm install…)
    // are tracked separately: they don't produce a re-readable artifact and typically FOLLOW verification
    // (test → commit), so they don't reset that ordering window — see the shell-mutation clause below.
    let lastMutIdx = -1;
    for (let i = 0; i < toolUses.length; i++) if (MUT.has(toolUses[i].name)) lastMutIdx = i;
    const mutations = toolUses.filter(t => MUT.has(t.name));
    const shellMuts = toolUses.filter(t => SHELL.has(t.name) && isShellMutation(t.input && t.input.command));
    audit(`DIAG event=${event} mode=${MODELABEL} tx=${tp.split(/[\\/]/).pop()} settled=${settled} idx=${startIdx}/${objs.length} muts=${mutations.length} shellMuts=${shellMuts.length} lastMut=${lastMutIdx} tools=[${toolUses.map(t => t.name).join(',')}] tail=${JSON.stringify((lastText || '').slice(-70))}`);
    if (lastMutIdx < 0 && !shellMuts.length) return allow('no mutation this turn (exempt)');
    const writtenPaths = mutations
      .map(t => (t.input.file_path || t.input.notebook_path || '').replace(/\\/g, '/'))
      .filter(Boolean);

    // (2) completion claim in closing message?
    // Scan only the closing-message TAIL (sign-off region) so a "done"/"works" buried in the
    // mid-message analysis of a long turn doesn't trip the gate. (This is DELIBERATE and tested — test 10:
    // an early-prose "I am done reviewing…" with a neutral tail must ALLOW. An adversarial review proposed
    // also scanning the HEAD to catch a sign-off claim hidden by >1200 chars of tail-padding, but that
    // reintroduces exactly the analytical-prose false positive the tail-only window exists to avoid, so it
    // was rejected — the tail-padding escape is a low-severity theoretical case not worth the false blocks.)
    // The claim WORD list is kept intact on purpose (narrowing it would risk missing real fakes — fail-closed).
    const claimTail = (lastText || '').slice(-1200);
    // matchesUnnegated (not a bare .test): a claim word right after a negator is an honest negative, not a
    // claim — so "this is still not working, tests don't pass" is ALLOWed instead of being false-blocked.
    const claimPat = CLAIM_EFF.find(p => matchesUnnegated(claimTail, p));
    if (!claimPat) return allow('no completion claim in closing-message tail');

    // (3) verification signature — must occur AFTER the last mutation (verification-of-change,
    // not verification-of-original). A test/read that ran BEFORE the final edit proves nothing
    // about that edit, so we only scan tool uses at index > lastMutIdx.
    let verified = false, why = '';
    let ranCmdPostMut = false; // did a real Bash/PowerShell command (or mode verify-tool) run after the last mutation?
    for (let i = lastMutIdx + 1; i < toolUses.length; i++) {
      const t = toolUses[i];
      // A bare re-read clears the gate in 'general' (and re-read-friendly modes). Modes whose proof
      // is "you actually RAN something" set reReadClears:false, so seeing your own edit is NOT proof.
      if (RE_READ_CLEARS && t.name === 'Read') {
        const fp = (t.input.file_path || '').replace(/\\/g, '/');
        // Exact-or-path-boundary match (NOT a loose substring): re-reading a.js clears a claim about a.js,
        // but re-reading a.js.bak does NOT (see samePath). Matches the shell-cat path's token-boundary guard.
        if (fp && writtenPaths.some(w => samePath(fp, w))) { verified = true; why = 're-read of written path'; }
      }
      // Mode-registered verification TOOLS (MCP screenshot/Lighthouse, WebSearch/WebFetch, ...).
      // Running one post-mutation is itself the proof, and counts as "a real action ran" so a
      // backing evidence marker can also clear.
      if (!verified && VERIFY_TOOLS.length && VERIFY_TOOLS.some(r => r.test(t.name || ''))) {
        verified = true; why = `mode verify-tool ran (${t.name})`; ranCmdPostMut = true;
      }
      if (SHELL.has(t.name)) {
        const cmd = t.input.command || '';
        // A command that VISIBLY FAILED (is_error / failure signature) is not "verification" — running a red
        // test/build then claiming done is the exact fake-finish we block. A failed command also can't back an
        // evidence marker. (Unlocatable result ⇒ failed=false ⇒ unchanged fail-open behavior.)
        const failed = cmdFailed(t);
        // WP-1.3: only a real test/verify OR file-read command arms the evidence-marker path — an
        // `echo ok` / `ls` no longer counts as "a real command ran", so a mutate → `echo` → self-typed
        // "$ npm test / 12 passed" prose can't fake-finish (the marker path needs a genuine command behind it).
        if (!failed && (someTest(cmd) || someFileRead(cmd))) ranCmdPostMut = true;
        if (RE_READ_CLEARS && !failed && someFileRead(cmd) && writtenPaths.some(w => w && cmdReadsFile(cmd, w.split('/').pop()))) { verified = true; why = 'cat/type of written file'; }
        if (!verified && !failed && someTest(cmd)) { verified = true; why = 'test/verify command ran (passed)'; }
      }
      if (verified) break;
    }
    // Text evidence markers clear the gate ONLY if a real command (or verify-tool) actually ran
    // post-mutation. In 'general' (and re-read-friendly modes) any post-mutation command + a marker
    // clears — this is the documented general behavior (test 14). But a reReadClears:false mode means
    // "passive signals don't count — you must actually RUN a recognized verification": there, the
    // prose-marker shortcut is DISABLED (gated on RE_READ_CLEARS), so an `echo`/`ls` + a self-typed
    // marker can't fake-finish. Only a real someTest()/VERIFY_TOOLS match (above) clears a tight mode.
    if (!verified && RE_READ_CLEARS && ranCmdPostMut && EV_EFF.some(p => p.test(lastText))) { verified = true; why = 'evidence marker backed by a post-mutation command'; }
    if (verified) return allow(`claim+mutation but verified (${why}) [mode=${MODELABEL}]`);

    // Wording adapts to WHAT was mutated: file edits (Write/Edit) and/or shell mutations (rm/git commit/…).
    const fileN = mutations.length, shellN = shellMuts.length;
    const mutSummary = fileN && shellN ? `mutated ${fileN} file(s) and ran ${shellN} mutating command(s)`
      : fileN ? `mutated ${fileN} file(s)`
      : `ran ${shellN} mutating command(s)`;
    const changedLine = writtenPaths.length
      ? `Files changed this turn: ${writtenPaths.join(', ')}.`
      : shellN ? `Mutating command(s): ${shellMuts.map(t => (t.input.command || '').replace(/\s+/g, ' ').trim().slice(0, 60)).join(' | ')}.`
      : `Files changed this turn: (paths not captured).`;
    const reReadBullet = !fileN
      ? `  - A shell mutation (commit/install/rm/redirect) clears when a passing test/build/check ran in the SAME turn — run one, OR\n`
      : RE_READ_CLEARS
      ? `  - Re-read the file(s) you changed (after the edit) and confirm the change is actually present and correct, OR\n`
      : `  - (A bare re-read does NOT count in ${MODELABEL} mode — seeing your edit is not proof it works.)\n`;
    return block(
      `Proof-of-work gate (${event}${MODELABEL !== 'general' ? `, ${MODELABEL} mode` : ''}): you are ending a turn that ${mutSummary} and asserts completion ` +
      `(matched ${claimPat}), but this turn shows NO passing verification for that work.\n\n` +
      `Per the Deterministic Operating Contract rule 3 (evidence-or-flag) and rule 4 (re-audit before done): before you stop, do ONE of:\n` +
      reReadBullet +
      `  - Run the relevant test / build / check / query / browser-capture command and show its output, OR\n` +
      `  - If you genuinely cannot verify, REWRITE your closing message to drop the completion claim and state explicitly what is unverified and why.\n\n` +
      `Note: writing "exit 0" / "tests pass" / "$ cmd" as text does NOT count unless a real command actually ran.\n` +
      `${changedLine}\n` +
      `This is one bounce (circuit breaker allows the next stop), so make it count: verify or downgrade the claim.`
    );
  } catch (err) {
    return allow(`unexpected error (fail-open): ${err && err.message}`);
  }
}

// In-process entrypoint: godmode-gate.mjs requires this module and calls decide(data) directly.
module.exports = decide;

// CLI entrypoint — identical observable behavior to before (read stdin, decide, emit any block JSON,
// exit 0). The test harness and the wrapper's spawn-fallback both invoke the gate this way.
if (require.main === module) {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => {
    let out = '';
    try { out = decide(data); } catch (_) { out = ''; } // belt-and-suspenders fail-open (decide is already guarded)
    if (out) process.stdout.write(out);
    process.exit(0);
  });
}
