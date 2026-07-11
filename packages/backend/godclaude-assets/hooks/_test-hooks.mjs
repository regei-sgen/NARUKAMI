// Both-directions test harness for the deterministic-hook layer.
// Builds synthetic transcript JSONL fixtures, runs each hook as the harness would
// (JSON on stdin), and asserts ALLOW vs BLOCK / injection output.
// Run: node _test-hooks.mjs   (exit 0 = all pass, exit 1 = a case failed)

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Per-session state is keyed by the Claude Code session id (the CLI reads CLAUDE_CODE_SESSION_ID;
// hooks read the payload's session_id). The suite inherits the real session's env when run inside
// Claude Code — SCRUB it here so every existing assertion exercises the GLOBAL / no-session FALLBACK
// path (the unchanged legacy behavior). Every env builder below spreads process.env AFTER this scrub,
// so none leaks the real id. Session-scoped assertions opt IN by passing an explicit id (env for the
// CLI, payload.session_id for hooks).
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CODE_CHILD_SESSION;

// Resolve the hooks NEXT TO this test file — not via ~/.claude/hooks. Run from a source checkout
// (assets/hooks/) → tests the SOURCE hooks you just edited; run as the installed self-check
// (~/.claude/hooks/_test-hooks.mjs, how install.mjs invokes it) → tests the INSTALLED hooks.
// Either way the suite tests the code sitting beside it, never a stale copy somewhere else.
const HOOKS = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const GATE = `${HOOKS}/block-unverified-completion.js`;
const INJECT = `${HOOKS}/inject-deterministic-contract.js`;
const DRIFT = `${HOOKS}/inject-anti-drift.js`;
const END = `${HOOKS}/godsession-end.js`;
const FIX = `${HOOKS}/_testfix`;
fs.mkdirSync(FIX, { recursive: true });
fs.mkdirSync(`${FIX}/.claude`, { recursive: true }); // sandbox home so gate audit/log writes never touch the real ~/.claude
// Mode-system seams: the modes live one dir up (assets/modes in source, ~/.claude/modes when
// installed). GODMODE_MODES_DIR lets us point the resolver/gate at them without an install.
const MODES_DIR = path.resolve(HOOKS, '..', 'modes').replace(/\\/g, '/');
const CLI = path.resolve(HOOKS, '..', 'godmode.mjs').replace(/\\/g, '/');

// ---- transcript building blocks ----
const userPrompt = (t) => ({ type: 'user', message: { role: 'user', content: t } });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const asstTool = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });
const asstText = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const WP = 'C:/work/sample/thing.js';
const WP2 = 'C:/work/sample/other.js';

function writeFixture(name, objs) {
  const p = `${FIX}/${name}.jsonl`;
  fs.writeFileSync(p, objs.map(o => JSON.stringify(o)).join('\n') + '\n');
  return p;
}

// mode defaults to 'general' so the base-gate cases test the BASE gate regardless of whatever mode
// happens to be active on this machine (GODMODE_MODE env overrides the godmode-mode file).
function runGate(transcriptPath, { event = 'Stop', stopActive = false, mode = 'general', cwd } = {}) {
  const payload = { hook_event_name: event, transcript_path: transcriptPath, stop_hook_active: stopActive };
  if (cwd !== undefined) payload.cwd = cwd; // engages path-gating for scoped modes (those shipping scope.json)
  const input = JSON.stringify(payload);
  // DET_HOOKS_HOME=FIX keeps the gate's audit log inside the sandbox (not the user's real ~/.claude),
  // including when this suite runs as the installer self-check (which sets DET_HOOKS_HOME=real home).
  const env = { ...process.env, GODMODE_MODE: mode, GODMODE_MODES_DIR: MODES_DIR, DET_HOOKS_HOME: FIX };
  let out = '';
  try { out = execFileSync('node', [GATE], { input, encoding: 'utf8', env }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const blocked = /"decision"\s*:\s*"block"/.test(out);
  return { blocked, out };
}
// `home` (optional) points DET_HOOKS_HOME at a sandbox with its own modes/ + base contract (for scope
// tests); else the real home + source MODES_DIR (the original behavior). `cwd` engages path-gating.
function runInject(hook, event, { mode = 'general', cwd, home } = {}) {
  const payload = { hook_event_name: event };
  if (cwd !== undefined) payload.cwd = cwd;
  const input = JSON.stringify(payload);
  const env = home
    ? { ...process.env, GODMODE_MODE: mode, GODMODE_MODES_DIR: '', DET_HOOKS_HOME: home }
    : { ...process.env, GODMODE_MODE: mode, GODMODE_MODES_DIR: MODES_DIR };
  let out = '';
  try { out = execFileSync('node', [hook], { input, encoding: 'utf8', env }); } catch (e) { out = e.stdout || ''; }
  return out;
}

// ---- cases ----
const cases = [];
const expect = (name, got, want) => cases.push({ name, pass: got === want, got, want });

// 1. FAIL → BLOCK: mutation + completion claim + no verification
{
  const f = writeFixture('block_basic', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Done — fixed the bug, it works now.')
  ]);
  expect('1. mutation+claim+no-evidence → BLOCK', runGate(f).blocked, true);
}
// 2. ALLOW: re-read of written path AFTER the write
{
  const f = writeFixture('allow_reread', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstTool('Read', { file_path: WP }),
    toolResult(),
    asstText('Done — re-read it, the fix is present and correct.')
  ]);
  expect('2. mutation+claim+post-edit re-read → ALLOW', runGate(f).blocked, false);
}
// 3. ALLOW: no mutation (pure answer)
{
  const f = writeFixture('allow_nomutation', [
    userPrompt('what does this function do?'),
    asstText('It validates input. Done — that is the complete answer and it works.')
  ]);
  expect('3. no-mutation (exempt) → ALLOW', runGate(f).blocked, false);
}
// 4. ALLOW: mutation but no completion claim
{
  const f = writeFixture('allow_noclaim', [
    userPrompt('draft a paragraph'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('I drafted the paragraph. Take a look and tell me if the direction is right.')
  ]);
  expect('4. mutation, no claim → ALLOW', runGate(f).blocked, false);
}
// 5. BLOCK: TEXT evidence marker with NO command behind it (fabricated proof) — the prose-marker hole, now closed.
{
  const f = writeFixture('block_textevidence_nocmd', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstText('Fixed. Evidence:\n```\n$ node thing.js\nOK exit 0\n```')
  ]);
  expect('5. mutation+claim+text-only "evidence" (no command ran) → BLOCK', runGate(f).blocked, true);
}
// 6. ALLOW: test command ran AFTER the edit
{
  const f = writeFixture('allow_testcmd', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'npm test' }),
    toolResult(),
    asstText('All tests pass now — fixed and verified.')
  ]);
  expect('6. mutation+claim+post-edit npm test → ALLOW', runGate(f).blocked, false);
}
// 7. ALLOW: circuit breaker (stop_hook_active)
{
  const f = writeFixture('cb', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Done, it works.')
  ]);
  expect('7. would-block but stop_hook_active → ALLOW', runGate(f, { stopActive: true }).blocked, false);
}
// 8. FAIL → BLOCK on SubagentStop (subagent gating). SubagentStop hands the gate the MAIN transcript +
// agent_id; the gate must DERIVE the subagent's own transcript (direct: subagents/agent-<id>.jsonl) and
// judge THAT. This exercises the direct-Task-subagent derivation path (test 316 covers workflow-nested).
{
  const aid = 'aDIRECTSUB8';
  const mainTp = `${FIX}/sub8_main.jsonl`;
  fs.writeFileSync(mainTp, JSON.stringify(userPrompt('fix the bug in a subagent')) + '\n'); // parent must exist
  const subDir = `${FIX}/sub8_main/subagents`;
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(`${subDir}/agent-${aid}.jsonl`, [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Implemented successfully, ready to go.')
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  const payload = JSON.stringify({ hook_event_name: 'SubagentStop', transcript_path: mainTp, agent_id: aid, stop_hook_active: false });
  let out = ''; try { out = execFileSync('node', [GATE], { input: payload, encoding: 'utf8', env: { ...process.env, GODMODE_MODE: 'general', GODMODE_MODES_DIR: MODES_DIR, DET_HOOKS_HOME: FIX } }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  expect('8. SubagentStop mutation+claim+no-evidence (derived direct subagent tx) → BLOCK', /"decision"\s*:\s*"block"/.test(out), true);
}
// 9. BLOCK: a BARE fenced code block is not evidence
{
  const f = writeFixture('block_bareblock', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Fixed it, it works now.\n```\nsome quoted log line\nanother line\n```')
  ]);
  expect('9. mutation+claim+BARE code block (no real evidence) → BLOCK', runGate(f).blocked, true);
}
// 10. ALLOW: claim word only in EARLY prose, neutral tail (>1200 chars)
{
  const longNeutral = 'I will now explain the analysis in detail. ' + 'The approach considers many factors and trade-offs across the larger architecture. '.repeat(30) + 'Let me know your thoughts on the direction.';
  const f = writeFixture('allow_claim_early_only', [
    userPrompt('analyze and tweak'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstText('I am done reviewing. ' + longNeutral)
  ]);
  expect('10. claim only in early prose, neutral tail → ALLOW', runGate(f).blocked, false);
}
// 11. BLOCK: a $-prompt line typed as prose (no command ran) is not evidence — the shell-prompt hole, now closed.
{
  const f = writeFixture('block_shellprompt_nocmd', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstText('Fixed and confirmed working:\n```\n$ node thing.js\nrunning...\nall good\n```')
  ]);
  expect('11. mutation+claim+text-only "$ cmd" (no command ran) → BLOCK', runGate(f).blocked, true);
}

// ---- ORDERING: verification must come AFTER the last mutation ----
// 12. BLOCK: a test that ran BEFORE the edit does not verify the edit (same text as case 6, order reversed).
{
  const f = writeFixture('block_test_before_edit', [
    userPrompt('fix the bug'),
    asstTool('Bash', { command: 'npm test' }),
    toolResult(),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstText('All tests pass now — fixed and verified.')
  ]);
  expect('12. test BEFORE edit (no post-edit verify) → BLOCK', runGate(f).blocked, true);
}
// 13. BLOCK: a Read BEFORE the edit (read-to-plan) does not verify the edit.
{
  const f = writeFixture('block_read_before_edit', [
    userPrompt('fix the bug'),
    asstTool('Read', { file_path: WP }),
    toolResult(),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstText('Done — fixed it, works now.')
  ]);
  expect('13. read BEFORE edit (no post-edit verify) → BLOCK', runGate(f).blocked, true);
}

// ---- COMMAND-BACKED text evidence (the legitimate counterpart of cases 5 & 11) ----
// 14. WP-1.3: a NO-OP command (echo) + a self-typed evidence marker no longer fakes-finish → BLOCK.
// (Was the A3 exploit: `echo ok` armed the prose-marker path. Now only a real test/read command arms it.)
{
  const f = writeFixture('block_echo_plus_marker', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'echo ok' }),
    toolResult(),
    asstText('Fixed.\nEvidence:\n```\n$ npm test\n12 passed\n```')
  ]);
  expect('14. WP-1.3: echo (no-op) + self-typed "$ npm test / N passed" marker → BLOCK (exploit closed)', runGate(f).blocked, true);
}
// 15. WP-1.3: `git diff` merely DISPLAYS the edit — it exercises nothing, so it no longer counts as
// verification → BLOCK (bare `diff` was dropped from TEST_CMD).
{
  const f = writeFixture('block_gitdiff_only', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'git diff' }),
    toolResult(),
    asstText('Done — the diff shows the fix is in.')
  ]);
  expect('15. WP-1.3: `git diff` only (displays, not exercises) + claim → BLOCK', runGate(f).blocked, true);
}
// 15c. WP-1.3: a REAL post-edit verification command still clears → ALLOW (the tightening only removes
// no-op/display commands, not genuine tests).
{
  const f = writeFixture('allow_real_test', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'npm test' }),
    toolResult(),
    asstText('Done — the suite passes.')
  ]);
  expect('15c. WP-1.3: real post-edit `npm test` (passes) + claim → ALLOW', runGate(f).blocked, false);
}
// 15d. WP-1.3: bare `curl` token in prose no longer counts; a real curl to a URL does. (edit + `curl URL` → ALLOW)
{
  const f = writeFixture('allow_curl_url', [
    userPrompt('fix the endpoint'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'curl http://localhost:3000/health' }),
    toolResult(),
    asstText('Done — the endpoint returns 200.')
  ]);
  expect('15d. WP-1.3: real `curl <url>` post-edit + claim → ALLOW', runGate(f).blocked, false);
}
// ---- WP-1.2: shell mutations (rm/git commit/npm install/redirect) are gated even with NO file edit ----
{
  const sh = (cmd) => ({ ...asstTool('Bash', { command: cmd }) });
  // 15e. shell mutation (git commit) + claim + NO verification anywhere → BLOCK (the closed hole).
  expect('15e. WP-1.2: `git commit` + "done" + no verify → BLOCK',
    runGate(writeFixture('sm_commit_noverify', [userPrompt('commit it'), sh('git commit -m "fix"'), toolResult(), asstText('Done — committed.')])).blocked, true);
  // 15f. verify-then-commit in ONE command: the passing test clears the shell mutation → ALLOW (no false block).
  expect('15f. WP-1.2: `npm test && git commit` + "done" → ALLOW (verify-then-commit)',
    runGate(writeFixture('sm_test_commit', [userPrompt('test then commit'), sh('npm test && git commit -m done'), toolResult(), asstText('Done — tests pass, committed.')])).blocked, false);
  // 15g. shell mutation cleared by a separate passing verification in the same turn → ALLOW.
  expect('15g. WP-1.2: `rm -rf build` then `npm run build` (passes) + "done" → ALLOW',
    runGate(writeFixture('sm_rm_build', [userPrompt('clean rebuild'), sh('rm -rf build'), toolResult(), sh('npm run build'), toolResult(), asstText('Done — clean build succeeded.')])).blocked, false);
  // 15h. no file mutation AND no shell mutation (echo/ls/grep only) → exempt ALLOW (no false positive).
  expect('15h. WP-1.2: echo/ls/grep-only turn + "done" → exempt ALLOW',
    runGate(writeFixture('sm_noop', [userPrompt('look around'), sh('echo hi'), toolResult(), sh('ls -la'), toolResult(), sh('grep -rn foo src'), toolResult(), asstText('Done — looked it over.')])).blocked, false);
  // 15i. the review's proven FALSE-POSITIVE commands must NOT be classified as mutations → exempt ALLOW.
  for (const [i, cmd] of ['git log --format=%H', "awk '$3 > 100'", 'git log --grep "git commit convention"', 'ls | grep foo 2>/dev/null', 'echo "nevermind rm this"'].entries()) {
    expect(`15i.${i}. WP-1.2: read-only "${cmd.slice(0, 32)}" + "done" → exempt ALLOW (not a false-positive mutation)`,
      runGate(writeFixture(`sm_fp_${i}`, [userPrompt('inspect'), sh(cmd), toolResult(), asstText('Done — checked it.')])).blocked, false);
  }
}

// ---- PowerShell parity ----
// 16. ALLOW: PowerShell Get-Content of the written file (post-edit).
{
  const f = writeFixture('allow_pwsh_getcontent', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstTool('PowerShell', { command: 'Get-Content thing.js' }),
    toolResult(),
    asstText('Done — confirmed the change is in the file.')
  ]);
  expect('16. PowerShell Get-Content of written file → ALLOW', runGate(f).blocked, false);
}
// 17. ALLOW: PowerShell test/build command (post-edit).
{
  const f = writeFixture('allow_pwsh_build', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('PowerShell', { command: 'npm run build' }),
    toolResult(),
    asstText('Build is green — fixed.')
  ]);
  expect('17. PowerShell npm run build → ALLOW', runGate(f).blocked, false);
}

// ---- multi-file semantics (verify-ANY across writes is intentional & documented) ----
// 18. ALLOW: two files written, one re-read post-edit clears the gate (verify-any).
{
  const f = writeFixture('allow_multifile_reread_one', [
    userPrompt('change two files'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstTool('Write', { file_path: WP2, content: 'y' }),
    toolResult(),
    asstTool('Read', { file_path: WP }),
    toolResult(),
    asstText('Done — both updated; re-read the main one to confirm.')
  ]);
  expect('18. multi-file, re-read one (verify-any) → ALLOW', runGate(f).blocked, false);
}

// ---- cat/type boundary guard (false-positive collisions are NOT verification) ----
// 19. BLOCK: `cat thing.js.bak` must not "verify" a written `thing.js` (different file).
{
  const f = writeFixture('block_catbak_collision', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstTool('Bash', { command: 'cat thing.js.bak' }),
    toolResult(),
    asstText('Done, fixed.')
  ]);
  expect('19. cat of a DIFFERENT same-prefix file → BLOCK', runGate(f).blocked, true);
}
// 20. ALLOW: `cat path/thing.js` (a path-qualified hit) does verify the written `thing.js`.
{
  const f = writeFixture('allow_cat_pathqualified', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstTool('Bash', { command: 'cat sample/thing.js' }),
    toolResult(),
    asstText('Done — dumped the file, the change is there.')
  ]);
  expect('20. cat of the written file (path-qualified) → ALLOW', runGate(f).blocked, false);
}

// ---- TEST_CMD variety (only npm was exercised before) ----
// 21. ALLOW: pytest post-edit.
{
  const f = writeFixture('allow_pytest', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'pytest -q' }),
    toolResult(),
    asstText('Fixed — pytest is green.')
  ]);
  expect('21. post-edit pytest → ALLOW', runGate(f).blocked, false);
}
// 22. ALLOW: go test post-edit.
{
  const f = writeFixture('allow_gotest', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'go test ./...' }),
    toolResult(),
    asstText('Fixed and verified — go test passes.')
  ]);
  expect('22. post-edit go test → ALLOW', runGate(f).blocked, false);
}

// 23-25. injectors
{
  const o = runInject(INJECT, 'SessionStart');
  expect('23. inject SessionStart has contract', /Deterministic Operating Contract/.test(o) && /"hookEventName":"SessionStart"/.test(o), true);
}
{
  const o = runInject(INJECT, 'SubagentStart');
  expect('24. inject echoes SubagentStart event', /"hookEventName":"SubagentStart"/.test(o) && /Deterministic Operating Contract/.test(o), true);
}
{
  const o = runInject(DRIFT, 'UserPromptSubmit');
  expect('25. anti-drift emits reminder', /Deterministic Operating Contract/.test(o) && /post-edit verification/i.test(o), true);
  // EXPLICIT per-prompt mode banner: every UserPromptSubmit injection states which mode is handling the prompt.
  expect('25b. anti-drift states the ACTIVE MODE explicitly (general)', /Active mode for this prompt: general \(base contract\)/.test(o), true);
  const oData = runInject(DRIFT, 'UserPromptSubmit', { mode: 'data-analyst' });
  expect('25c. anti-drift names the active mode + its alias', /Active mode for this prompt: data-analyst \(goddata\)/.test(oData), true);
}

// 26. (Windows only) a backslash transcript_path is handled (BLOCK on unverified claim).
if (process.platform === 'win32') {
  const f = writeFixture('block_backslash_path', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Done, it works.')
  ]);
  expect('26. backslash transcript_path → BLOCK', runGate(f.replace(/\//g, '\\')).blocked, true);
}

// ---- godmode-gate.mjs (opt-in wrapper): DORMANT = emit nothing (allow/no-inject); ACTIVE = transparent ----
const WRAP = `${HOOKS}/godmode-gate.mjs`;
function runWrappedGate(transcriptPath, { active = false } = {}) {
  const input = JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath, stop_hook_active: false });
  // GODMODE_PERF=0 + DET_HOOKS_HOME=FIX keep these decision-only checks from writing perf/audit
  // logs into the real ~/.claude (perf logging itself is covered by test-godmode-perf.mjs).
  const env = { ...process.env, GODMODE_ACTIVE: active ? '1' : '0', GODMODE_PERF: '0', DET_HOOKS_HOME: FIX, GODMODE_MODE: 'general' };
  let out = '';
  try { out = execFileSync('node', [WRAP, GATE], { input, encoding: 'utf8', env }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return /"decision"\s*:\s*"block"/.test(out);
}
{
  const f = writeFixture('wrap_wouldblock', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Done, it works.')
  ]);
  // Same would-block turn: dormant wrapper lets it pass; active wrapper forwards the real gate's BLOCK.
  expect('27. wrapper DORMANT on would-block → ALLOW (layer off)', runWrappedGate(f, { active: false }), false);
  expect('28. wrapper ACTIVE on would-block → BLOCK (transparent)', runWrappedGate(f, { active: true }), true);
}
{
  const f = writeFixture('wrap_clean', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstTool('Read', { file_path: WP }),
    toolResult(),
    asstText('Done — re-read it, the fix is present.')
  ]);
  expect('29. wrapper ACTIVE on a verified turn → ALLOW', runWrappedGate(f, { active: true }), false);
}

// 30. The anti-drift reminder fires on EVERY UserPromptSubmit, so its length is a permanent per-turn
// token tax. Guard it: assert the emitted reminder stays under a char ceiling so a future edit can't
// silently ratchet the every-prompt cost upward. Raise CEIL deliberately if a rule is added — never
// let it drift up unnoticed. (This is the one cost-bearing string in the layer with no other guard.)
{
  const o = runInject(DRIFT, 'UserPromptSubmit');
  let len = 0;
  try { len = JSON.parse(o).hookSpecificOutput.additionalContext.length; } catch (_) {}
  // chars. Bumped 520→600 when the explicit per-prompt mode banner was added (general additionalContext
  // is now ~501: the "[GODCLAUDE] Active mode for this prompt: …" line + the general reminder). Keeps ~99
  // chars headroom for small edits while still tripping on real bloat. Raise DELIBERATELY if a rule is added.
  const CEIL = 600;
  expect('30. anti-drift reminder under length ceiling (per-turn tax guard)', len > 0 && len <= CEIL, true);
}

// ====================================================================================
// ===== MODE SYSTEM (GODCLAUDE multi-mode): resolver, gate overrides, injectors, CLI =====
// A mode is ADDITIVE over the base gate (more claim words / more accepted proofs) and may TIGHTEN
// (require a real command instead of a bare re-read) — but can never drop below the general floor.
// ====================================================================================
function runResolver(env) {
  // Build the child env ONCE; '' = unset (resolver treats empty GODMODE_MODE as unset, etc.).
  const e = { ...process.env, GODMODE_MODE: '', GODMODE_MODES_DIR: '', DET_HOOKS_HOME: '', ...env };
  try { return execFileSync('node', ['-e', "process.stdout.write(require('./godmode-mode.js').resolveMode())"], { cwd: HOOKS, env: e, encoding: 'utf8' }).trim(); }
  catch (_) { return 'ERR'; }
}
function canonSays(input) {
  try { return execFileSync('node', ['-e', `process.stdout.write(require('./godmode-mode.js').canonicalMode(${JSON.stringify(input)}))`], { cwd: HOOKS, encoding: 'utf8' }).trim(); }
  catch (_) { return 'ERR'; }
}

// 31-34. Resolver precedence + validation + fail-safe to 'general'.
{
  const noFileHome = `${FIX}/nomode`; fs.mkdirSync(`${noFileHome}/.claude`, { recursive: true });
  expect('31. resolver: no env, no godmode-mode file → general', runResolver({ DET_HOOKS_HOME: noFileHome }), 'general');
  expect('32. resolver: GODMODE_MODE=qa (valid folder) → qa', runResolver({ GODMODE_MODE: 'qa', GODMODE_MODES_DIR: MODES_DIR }), 'qa');
  expect('33. resolver: GODMODE_MODE=bogus (unknown) → general', runResolver({ GODMODE_MODE: 'bogus', GODMODE_MODES_DIR: MODES_DIR }), 'general');
  const fileHome = `${FIX}/filemode`; fs.mkdirSync(`${fileHome}/.claude`, { recursive: true });
  fs.writeFileSync(`${fileHome}/.claude/godmode-mode`, 'developer\n');
  expect('34. resolver: godmode-mode file = developer → developer', runResolver({ DET_HOOKS_HOME: fileHome, GODMODE_MODES_DIR: MODES_DIR }), 'developer');
  // MERGE: a legacy file holding the now-removed 'debugger'/'ui-ux' still resolves (via alias) to developer.
  const legacyHome = `${FIX}/legacymode`; fs.mkdirSync(`${legacyHome}/.claude`, { recursive: true });
  fs.writeFileSync(`${legacyHome}/.claude/godmode-mode`, 'debugger\n');
  expect('34b. resolver: legacy file = debugger → developer (merged alias, no dead mode)', runResolver({ DET_HOOKS_HOME: legacyHome, GODMODE_MODES_DIR: MODES_DIR }), 'developer');
  fs.writeFileSync(`${legacyHome}/.claude/godmode-mode`, 'ui-ux\n');
  expect('34c. resolver: legacy file = ui-ux → developer (merged alias, no dead mode)', runResolver({ DET_HOOKS_HOME: legacyHome, GODMODE_MODES_DIR: MODES_DIR }), 'developer');
}
// 35-37. canonicalMode alias map ("call out the name" -> canonical folder). MERGE: godbug/godpixel → developer.
{
  expect('35. canonical: godbug → developer (debugger merged in)', canonSays('godbug'), 'developer');
  expect('35b. canonical: godpixel → developer (ui-ux merged in)', canonSays('godpixel'), 'developer');
  expect('36. canonical: goddata → data-analyst', canonSays('goddata'), 'data-analyst');
  expect('37. canonical: unknown → "" (empty)', canonSays('definitely-not-a-mode'), '');
}
// 37b-h. Part B (Kami): kami pseudonyms resolve to canonical modes; amaterasu → general (special-cased,
// NOT an ALIASES key so validateFolder is unaffected); GODNAME is a display map keyed by canonical id.
{
  expect('37b. Kami: mahitotsu → developer', canonSays('mahitotsu'), 'developer');
  expect('37c. Kami: kuebiko → researcher', canonSays('kuebiko'), 'researcher');
  expect('37d. Kami: tsukuyomi → data-analyst', canonSays('tsukuyomi'), 'data-analyst');
  expect('37e. Kami: enma → qa; susanoo → reviewer; omoikane → planner',
    [canonSays('enma'), canonSays('susanoo'), canonSays('omoikane')].join(','), 'qa,reviewer,planner');
  expect('37f. Kami: sarutahiko → ci-cd; uzume → web-builder',
    [canonSays('sarutahiko'), canonSays('uzume')].join(','), 'ci-cd,web-builder');
  expect('37g. Kami: amaterasu → general (special-cased; general has no ALIASES entry)', canonSays('amaterasu'), 'general');
  expect('37h. Kami: casing-insensitive (Mahitotsu → developer)', canonSays('Mahitotsu'), 'developer');
  // GODNAME display map: every canonical id (+ general) has a pseudonym; keys stay canonical.
  let gn = {}; try { gn = JSON.parse(execFileSync('node', ['-e', `const m=require(${JSON.stringify(HOOKS + '/godmode-mode.js')}); process.stdout.write(JSON.stringify(m.GODNAME))`], { encoding: 'utf8' })); } catch (_) {}
  expect('37i. Kami: GODNAME maps canonical ids → pseudonyms (developer=Mahitotsu, general=Amaterasu)', gn.developer === 'Mahitotsu' && gn.general === 'Amaterasu' && gn['web-builder'] === 'Uzume', true);
  // amaterasu must flow through the RESOLVER to general (no dead-folder lookup, validateFolder unaffected):
  // a session whose persisted mode is 'amaterasu' resolves to general, exactly like the literal 'general'.
  const amaterasuHome = `${FIX}/amaterasumode`; fs.mkdirSync(`${amaterasuHome}/.claude`, { recursive: true });
  fs.writeFileSync(`${amaterasuHome}/.claude/godmode-mode`, 'amaterasu\n');
  expect('37j. Kami: a persisted mode="amaterasu" resolves to general (not a dead mode/folder)', runResolver({ DET_HOOKS_HOME: amaterasuHome, GODMODE_MODES_DIR: MODES_DIR }), 'general');
  // test-56 invariant, Kami edition: the CLI canonicalizes a pseudonym BEFORE persisting — state files
  // always hold the canonical id (the machine-read contract), never the kami display name.
  const phHome = `${FIX}/kami_cli`; fs.rmSync(phHome, { recursive: true, force: true }); fs.mkdirSync(`${phHome}/.claude`, { recursive: true });
  try { execFileSync('node', [CLI, 'mahitotsu'], { encoding: 'utf8', env: { ...process.env, DET_HOOKS_HOME: phHome, GODMODE_MODE: '', GODMODE_MODES_DIR: MODES_DIR } }); } catch (_) {}
  let pm = ''; try { pm = fs.readFileSync(`${phHome}/.claude/godmode-mode`, 'utf8').trim(); } catch (_) {}
  expect('37k. Kami: CLI `mahitotsu` PERSISTS canonical "developer" (canonicalize-before-write holds)', pm, 'developer');
}

// 38-39. data-analyst: a query engine (duckdb) clears where the GENERAL gate would block.
{
  const f = writeFixture('mode_data_duckdb', [
    userPrompt('what is the row count?'),
    asstTool('Edit', { file_path: 'C:/work/sample/analysis.sql', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'duckdb -c "select count(*) from t"' }),
    toolResult(),
    asstText('The data shows 1,234 rows — done.')
  ]);
  expect('38. data-analyst: duckdb post-edit → ALLOW (mode adds it)', runGate(f, { mode: 'data-analyst' }).blocked, false);
  expect('39. same turn under general: duckdb unknown → BLOCK (floor unchanged)', runGate(f).blocked, true);
}
// 40-41. data-analyst tightening: re-read of the un-run script does NOT clear (general DOES clear).
{
  const f = writeFixture('mode_data_reread', [
    userPrompt('compute MoM growth'),
    asstTool('Edit', { file_path: 'C:/work/sample/analysis.sql', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Read', { file_path: 'C:/work/sample/analysis.sql' }),
    toolResult(),
    asstText('The data shows an upward trend — done.')
  ]);
  expect('40. general: re-read clears → ALLOW', runGate(f).blocked, false);
  expect('41. data-analyst: re-read does NOT clear (reReadClears:false) → BLOCK', runGate(f, { mode: 'data-analyst' }).blocked, true);
}
// 42-43. developer (ui-ux merged in): an MCP screenshot tool (matched by NAME) clears; general does not recognize it.
{
  const f = writeFixture('mode_uiux_screenshot', [
    userPrompt('restyle the button'),
    asstTool('Edit', { file_path: 'C:/work/ui/Button.tsx', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('mcp__chrome-devtools__take_screenshot', {}),
    toolResult(),
    asstText('Looks great on mobile — done.')
  ]);
  expect('42. developer: post-edit screenshot tool → ALLOW (ui-ux proof folded in)', runGate(f, { mode: 'developer' }).blocked, false);
  expect('43. same turn under general: screenshot tool unknown → BLOCK', runGate(f).blocked, true);
}
// 44-45. researcher: WebFetch (by tool name) clears; general does not.
{
  const f = writeFixture('mode_research_webfetch', [
    userPrompt('what is the latest node LTS?'),
    asstTool('Write', { file_path: 'C:/work/research/report.md', content: 'x' }),
    toolResult(),
    asstTool('WebFetch', { url: 'https://nodejs.org/en/about/previous-releases' }),
    toolResult(),
    asstText('The latest LTS is Node 22, per the docs. Done.')
  ]);
  expect('44. researcher: post-write WebFetch tool → ALLOW', runGate(f, { mode: 'researcher' }).blocked, false);
  expect('45. same turn under general: WebFetch unknown → BLOCK', runGate(f).blocked, true);
}
// 46-47. developer: a maven build clears; general (no mvn in TEST_CMD) blocks.
{
  const f = writeFixture('mode_dev_mvn', [
    userPrompt('finish the feature'),
    asstTool('Edit', { file_path: 'C:/work/src/Foo.java', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'mvn test' }),
    toolResult(),
    asstText('Done — shipped, builds clean.')
  ]);
  expect('46. developer: post-edit mvn test → ALLOW', runGate(f, { mode: 'developer' }).blocked, false);
  expect('47. same turn under general: mvn unknown → BLOCK', runGate(f).blocked, true);
}
// 48-49. ci-cd: a linter does NOT clear a green claim; an observed run does.
{
  const fa = writeFixture('mode_cicd_lint', [
    userPrompt('fix the pipeline'),
    asstTool('Edit', { file_path: 'C:/work/.github/workflows/deploy.yml', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'actionlint' }),
    toolResult(),
    asstText('Fixed the pipeline — CI is green now.')
  ]);
  expect('48. ci-cd: only a linter ran → BLOCK (lint ≠ run)', runGate(fa, { mode: 'ci-cd' }).blocked, true);
  const fb = writeFixture('mode_cicd_run', [
    userPrompt('fix the pipeline'),
    asstTool('Edit', { file_path: 'C:/work/.github/workflows/deploy.yml', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'gh run view 123 --json conclusion,status' }),
    toolResult(),
    asstText('Pipeline is green — conclusion: success.')
  ]);
  expect('49. ci-cd: observed gh run → ALLOW', runGate(fb, { mode: 'ci-cd' }).blocked, false);
}
// 50. developer (debugger merged in, reReadClears:false): re-read of the edit does NOT clear a fix claim (general would).
{
  const f = writeFixture('mode_debug_reread', [
    userPrompt('the login 500s'),
    asstTool('Edit', { file_path: 'C:/work/src/auth.py', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Read', { file_path: 'C:/work/src/auth.py' }),
    toolResult(),
    asstText('Fixed — root cause was a null token.')
  ]);
  expect('50. developer: re-read does NOT clear a fix claim → BLOCK (debugger floor merged in)', runGate(f, { mode: 'developer' }).blocked, true);
}
// 51. THE FLOOR: a mode never weakens the general gate — bare claim, zero verification → BLOCK.
{
  const f = writeFixture('mode_floor', [
    userPrompt('do the thing'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('done, it works.')
  ]);
  expect('51. data-analyst: bare claim, no proof → BLOCK (floor holds)', runGate(f, { mode: 'data-analyst' }).blocked, true);
}

// 52-53. injectors are mode-aware.
{
  const o = runInject(INJECT, 'SessionStart', { mode: 'qa' });
  expect('52. inject SessionStart in qa mode → qa contract', /qa mode/i.test(o) && /Deterministic Operating Contract/.test(o) && /"hookEventName":"SessionStart"/.test(o), true);
}
{
  const o = runInject(DRIFT, 'UserPromptSubmit', { mode: 'data-analyst' });
  expect('53. anti-drift in data-analyst mode → goddata reminder', /goddata/.test(o), true);
}

// 54-55. opt-in in-prompt keyword switch (default OFF; on only when godmode-keywords exists).
{
  const kwHome = `${FIX}/kwhome`; fs.mkdirSync(`${kwHome}/.claude`, { recursive: true });
  fs.writeFileSync(`${kwHome}/.claude/godmode-keywords`, 'enabled\n');
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'godmode:debugger the login endpoint 500s' });
  const env = { ...process.env, DET_HOOKS_HOME: kwHome, GODMODE_MODES_DIR: MODES_DIR, GODMODE_MODE: '' };
  let out = '';
  try { out = execFileSync('node', [DRIFT], { input, encoding: 'utf8', env }); } catch (e) { out = e.stdout || ''; }
  let persisted = '';
  try { persisted = fs.readFileSync(`${kwHome}/.claude/godmode-mode`, 'utf8').trim(); } catch (_) {}
  // MERGE: godmode:debugger canonicalizes to developer (debugger folded in) → persists 'developer' + injects the goddev reminder.
  expect('54. keyword (enabled): godmode:debugger → developer (merged) persists + injects its reminder', persisted === 'developer' && /goddev/.test(out), true);
}
{
  const kwOff = `${FIX}/kwoff`; fs.mkdirSync(`${kwOff}/.claude`, { recursive: true });
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'godmode:debugger do it' });
  const env = { ...process.env, DET_HOOKS_HOME: kwOff, GODMODE_MODES_DIR: MODES_DIR, GODMODE_MODE: '' };
  try { execFileSync('node', [DRIFT], { input, encoding: 'utf8', env }); } catch (_) {}
  expect('55. keyword (disabled): no godmode-keywords → no switch written', fs.existsSync(`${kwOff}/.claude/godmode-mode`), false);
}

// 56-58. the switch CLI writes the sentinels; `off` disarms.
{
  const cliHome = `${FIX}/clihome`;
  const env = { ...process.env, DET_HOOKS_HOME: cliHome, GODMODE_MODE: '' };
  try { execFileSync('node', [CLI, 'goddata'], { encoding: 'utf8', env }); } catch (_) {}
  let m = ''; try { m = fs.readFileSync(`${cliHome}/.claude/godmode-mode`, 'utf8').trim(); } catch (_) {}
  expect('56. CLI: `goddata` writes mode=data-analyst', m, 'data-analyst');
  expect('57. CLI: selecting a mode arms the layer (godmode-active exists)', fs.existsSync(`${cliHome}/.claude/godmode-active`), true);
  try { execFileSync('node', [CLI, 'off'], { encoding: 'utf8', env }); } catch (_) {}
  expect('58. CLI: `off` deletes godmode-active (dormant)', fs.existsSync(`${cliHome}/.claude/godmode-active`), false);
}
// 58b-58h. WP-2.4 CLI hardening — each a fresh repro of a confirmed MEDIUM from the blind-spot audit.
{
  const runCli = (args, extraEnv = {}) => {
    const env = { ...process.env, GODMODE_MODE: '', ...extraEnv };
    try { return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', env }) }; }
    catch (e) { return { code: e.status == null ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') }; }
  };
  // (1) An invalid --session id must HARD-ERROR and NEVER silently retarget the global default.
  const h1 = `${FIX}/cli_badsession`; fs.rmSync(h1, { recursive: true, force: true }); fs.mkdirSync(`${h1}/.claude`, { recursive: true });
  fs.writeFileSync(`${h1}/.claude/godmode-autosession`, 'enabled\n'); // GLOBAL autopilot armed
  const r1 = runCli(['autopilot', 'off', '--session', '5f3a/bad'], { DET_HOOKS_HOME: h1 });
  expect('58b. WP-2.4: `autopilot off --session <invalid>` → exit 1 (refuses, no silent retarget)', r1.code, 1);
  expect('58c. WP-2.4: the GLOBAL autopilot sentinel is UNTOUCHED by the rejected invalid --session', fs.existsSync(`${h1}/.claude/godmode-autosession`), true);
  const r1b = runCli(['autopilot', 'off', '--session', 'autopilot'], { DET_HOOKS_HOME: h1 });
  expect('58d. WP-2.4: `--session autopilot` (reserved word) → exit 1 + no phantom overlay dir', r1b.code === 1 && !fs.existsSync(`${h1}/.claude/godmode-sessions/autopilot`), true);
  // (2) A mode-switch write FAILURE must exit 1 with a ⚠, never print ✅ and exit 0. Simulate an unwritable
  // state by making `.claude` a FILE so every writeState under it fails.
  const h2 = `${FIX}/cli_unwritable`; fs.rmSync(h2, { recursive: true, force: true }); fs.mkdirSync(h2, { recursive: true });
  fs.writeFileSync(`${h2}/.claude`, 'not a dir');
  const r2 = runCli(['goddev'], { DET_HOOKS_HOME: h2 });
  expect('58e. WP-2.4: mode switch on unwritable state → exit 1 (not a ✅/exit-0 lie)', r2.code, 1);
  expect('58f. WP-2.4: the failed write prints ⚠, never "✅ GODCLAUDE mode: developer"', /⚠/.test(r2.out) && !/✅ GODCLAUDE mode: developer/.test(r2.out), true);
  // (3) An invalid on/off argument must not silently flip ON. `disabled` → OFF; a nonsense word → exit 1.
  const h3 = `${FIX}/cli_toggle`; fs.rmSync(h3, { recursive: true, force: true }); fs.mkdirSync(`${h3}/.claude`, { recursive: true });
  fs.writeFileSync(`${h3}/.claude/godmode-autosession`, 'enabled\n');
  runCli(['autopilot', 'disabled'], { DET_HOOKS_HOME: h3 });
  expect('58g. WP-2.4: `autopilot disabled` turns autopilot OFF (was silently turning it ON)', fs.existsSync(`${h3}/.claude/godmode-autosession`), false);
  const r3 = runCli(['autopilot', 'bogus'], { DET_HOOKS_HOME: h3 });
  expect('58h. WP-2.4: `autopilot <unknown>` → exit 1 (never silently arms)', r3.code, 1);
}

// ====================================================================================
// ===== REGRESSION: fixes from the adversarial gap review (findings #1-#16) ===========
// ====================================================================================
// 59-60. THE HIGH FINDING: in a reReadClears:false mode, a trivial command + a self-typed prose
// marker must NOT clear (the marker path is disabled when reReadClears:false). General is unaffected
// (test 14 still clears ./run.sh + a marker).
{
  const f = writeFixture('fix_marker_leak_data', [
    userPrompt('what is the total?'),
    asstTool('Edit', { file_path: 'C:/work/sample/analysis.sql', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'echo hello' }),
    toolResult(),
    asstText('The data shows the total is 42. shape: (100, 5) — done.')
  ]);
  expect('59. data-analyst: trivial cmd + prose marker does NOT clear (marker path off) → BLOCK', runGate(f, { mode: 'data-analyst' }).blocked, true);
}
{
  const f = writeFixture('fix_marker_leak_uiux', [
    userPrompt('restyle'),
    asstTool('Edit', { file_path: 'C:/work/ui/Button.tsx', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'ls' }),
    toolResult(),
    asstText('Looks great on mobile. screenshot saved at /tmp/x.png — done.')
  ]);
  expect('60. developer: `ls` + "screenshot saved" prose does NOT clear → BLOCK (ui-ux merged, reReadClears:false)', runGate(f, { mode: 'developer' }).blocked, true);
}
// 61. developer (ui-ux merged in): a non-capturing browser tool (navigate_page) does not count as a rendered artifact.
{
  const f = writeFixture('fix_uiux_navigate', [
    userPrompt('restyle'),
    asstTool('Edit', { file_path: 'C:/work/ui/Button.tsx', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('mcp__chrome-devtools__navigate_page', { url: 'http://localhost' }),
    toolResult(),
    asstText('Looks pixel-perfect now — done.')
  ]);
  expect('61. developer: navigate_page (no capture) does NOT clear → BLOCK', runGate(f, { mode: 'developer' }).blocked, true);
}
// 62. canonicalMode no longer leaks Object.prototype keys.
{
  expect('62a. canonical: constructor → "" (no prototype leak)', canonSays('constructor'), '');
  expect('62b. canonical: __proto__ → "" (no prototype leak)', canonSays('__proto__'), '');
}
// 63. data-analyst: a non-query python invocation does NOT clear; a real script does.
{
  const fa = writeFixture('fix_data_pyver', [
    userPrompt('row count?'),
    asstTool('Edit', { file_path: 'C:/work/sample/analysis.py', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'python --version' }),
    toolResult(),
    asstText('The data shows 42 rows returned — done.')
  ]);
  expect('63a. data-analyst: `python --version` does NOT clear → BLOCK', runGate(fa, { mode: 'data-analyst' }).blocked, true);
  const fb = writeFixture('fix_data_pyrun', [
    userPrompt('row count?'),
    asstTool('Edit', { file_path: 'C:/work/sample/analysis.py', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'python analyze.py' }),
    toolResult(),
    asstText('The data shows 42 rows returned — done.')
  ]);
  expect('63b. data-analyst: `python analyze.py` clears → ALLOW', runGate(fb, { mode: 'data-analyst' }).blocked, false);
}
// 64. qa: the bare `--coverage` flag in arbitrary text does NOT clear; a real runner does.
{
  const fa = writeFixture('fix_qa_echocov', [
    userPrompt('add coverage'),
    asstTool('Edit', { file_path: 'C:/work/foo.test.js', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'echo remember to run with --coverage' }),
    toolResult(),
    asstText('Covered the refund path — all green, no regressions.')
  ]);
  expect('64a. qa: `echo ... --coverage` text does NOT clear → BLOCK', runGate(fa, { mode: 'qa' }).blocked, true);
  const fb = writeFixture('fix_qa_pytestcov', [
    userPrompt('add coverage'),
    asstTool('Edit', { file_path: 'C:/work/foo.test.js', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'pytest --cov' }),
    toolResult(),
    asstText('Covered the refund path — all green, 12 passed.')
  ]);
  expect('64b. qa: real `pytest --cov` run clears → ALLOW', runGate(fb, { mode: 'qa' }).blocked, false);
}
// 65. developer (debugger merged in): `git stash` / bare `node scratch.js` do NOT clear; a named repro run does.
{
  const fa = writeFixture('fix_dbg_stash', [
    userPrompt('login 500s'),
    asstTool('Edit', { file_path: 'C:/work/auth.py', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'git stash' }),
    toolResult(),
    asstText('Fixed — root cause was a null token. now passes.')
  ]);
  expect('65a. developer: `git stash` does NOT clear → BLOCK', runGate(fa, { mode: 'developer' }).blocked, true);
  const fb = writeFixture('fix_dbg_scratch', [
    userPrompt('login 500s'),
    asstTool('Edit', { file_path: 'C:/work/auth.py', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'node scratch.js' }),
    toolResult(),
    asstText('Fixed — root cause was a null token.')
  ]);
  expect('65b. developer: bare `node scratch.js` does NOT clear → BLOCK', runGate(fb, { mode: 'developer' }).blocked, true);
  const fc = writeFixture('fix_dbg_repro', [
    userPrompt('login 500s'),
    asstTool('Edit', { file_path: 'C:/work/auth.py', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'node repro.js' }),
    toolResult(),
    asstText('Fixed — root cause was a null token; repro now passes.')
  ]);
  expect('65c. developer: a named `node repro.js` clears → ALLOW (debugger repro proof folded in)', runGate(fc, { mode: 'developer' }).blocked, false);
}
// 66. ci-cd: routine edit narration ("Applied the patch to the local file") is NOT a deploy claim;
//     a real deploy claim ("rolled out to prod") still gates.
{
  const fa = writeFixture('fix_cicd_applied_prose', [
    userPrompt('fix the typo'),
    asstTool('Edit', { file_path: 'C:/work/config.js', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstText('Applied the patch to the local file. The typo is gone.')
  ]);
  expect('66a. ci-cd: "Applied the patch to the local file" is not a deploy claim → ALLOW', runGate(fa, { mode: 'ci-cd' }).blocked, false);
  const fb = writeFixture('fix_cicd_rollout', [
    userPrompt('ship it'),
    asstTool('Edit', { file_path: 'C:/work/.github/workflows/deploy.yml', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstText('Rolled out to prod — done.')
  ]);
  expect('66b. ci-cd: "Rolled out to prod" still gates (no run observed) → BLOCK', runGate(fb, { mode: 'ci-cd' }).blocked, true);
}
// 67. researcher: a LOCAL code search does NOT clear an external-fact claim; a web-search MCP does.
{
  const fa = writeFixture('fix_research_localsearch', [
    userPrompt('what is the latest version?'),
    asstTool('Write', { file_path: 'C:/work/research/report.md', content: 'x' }),
    toolResult(),
    asstTool('mcp__codebase__search_symbols', { q: 'x' }),
    toolResult(),
    asstText('The latest version is 3.2, per the docs. Done.')
  ]);
  expect('67a. researcher: local mcp search does NOT clear an external-fact claim → BLOCK', runGate(fa, { mode: 'researcher' }).blocked, true);
  const fb = writeFixture('fix_research_websearch', [
    userPrompt('what is the latest version?'),
    asstTool('Write', { file_path: 'C:/work/research/report.md', content: 'x' }),
    toolResult(),
    asstTool('mcp__tavily__search', { q: 'latest version' }),
    toolResult(),
    asstText('The latest version is 3.2, per the docs. Done.')
  ]);
  expect('67b. researcher: a web-search MCP (tavily) clears → ALLOW', runGate(fb, { mode: 'researcher' }).blocked, false);
}
// 68. per-turn token-tax guard now covers ALL mode reminders, not just general.
{
  // 520→560: DELIBERATE raise — developer (goddev) absorbed debugger + ui-ux, so its reminder now
  // carries all three proof standards (build/test + repro red→green + render-capture) in one terse line
  // (~519 chars). Headroom kept small on purpose so real bloat still trips. Raise again only deliberately.
  const CEIL = 560;
  let maxLen = 0, who = '';
  for (const m of fs.readdirSync(MODES_DIR)) {
    let r = ''; try { r = fs.readFileSync(`${MODES_DIR}/${m}/reminder.txt`, 'utf8').trim(); } catch (_) {}
    if (r.length > maxLen) { maxLen = r.length; who = m; }
  }
  expect(`68. every mode reminder under length ceiling (max ${maxLen} = ${who})`, maxLen > 0 && maxLen <= CEIL, true);
}
// 68c. GATE HARDENING (audit fix): re-reading a SUPERSTRING-named file (a.js.bak) must NOT clear a claim
// about the file actually written (a.js) — the Read path now uses an exact/path-boundary match like the
// shell-cat path, not a loose substring.
{
  const f = writeFixture('reread_superstring', [
    userPrompt('fix it'),
    asstTool('Write', { file_path: 'C:/work/sample/a.js', content: 'x' }),
    toolResult(),
    asstTool('Read', { file_path: 'C:/work/sample/a.js.bak' }),
    toolResult(),
    asstText('Fixed a.js — it works now.'),
  ]);
  expect('68c. re-read of a.js.bak does NOT clear a claim about a.js → BLOCK (no superstring over-clear)', runGate(f).blocked, true);
  // positive control: re-reading the ACTUAL written file still clears.
  const fok = writeFixture('reread_exact', [
    userPrompt('fix it'),
    asstTool('Write', { file_path: 'C:/work/sample/a.js', content: 'x' }),
    toolResult(),
    asstTool('Read', { file_path: 'C:/work/sample/a.js' }),
    toolResult(),
    asstText('Fixed a.js — re-read it, the change is present.'),
  ]);
  expect('68d. re-read of the EXACT written file still clears → ALLOW (no over-block)', runGate(fok).blocked, false);
}
// 69. fail-SAFE without the wrapper: if godmode-mode.js is ABSENT beside the gate, the guarded require
//     degrades to general/base inline — the gate must STILL function (block unverified / allow verified),
//     not crash. (Proves Invariant C at the hook's own layer, not only via the opt-in wrapper.)
{
  const noRes = `${FIX}/noresolver`; fs.mkdirSync(noRes, { recursive: true });
  fs.copyFileSync(GATE, `${noRes}/block-unverified-completion.js`); // copy the gate ONLY — not godmode-mode.js
  const gateNoRes = `${noRes}/block-unverified-completion.js`;
  const runAt = (tp) => {
    const input = JSON.stringify({ hook_event_name: 'Stop', transcript_path: tp, stop_hook_active: false });
    let out = ''; try { out = execFileSync('node', [gateNoRes], { input, encoding: 'utf8', env: { ...process.env, DET_HOOKS_HOME: noRes, GODMODE_MODE: 'general' } }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    return /"decision"\s*:\s*"block"/.test(out);
  };
  const fblock = writeFixture('fix_noresolver_block', [
    userPrompt('fix it'), asstTool('Write', { file_path: WP, content: 'x' }), toolResult(), asstText('Done, it works.')
  ]);
  const fallow = writeFixture('fix_noresolver_allow', [
    userPrompt('fix it'), asstTool('Write', { file_path: WP, content: 'x' }), toolResult(),
    asstTool('Read', { file_path: WP }), toolResult(), asstText('Done — re-read, the change is present.')
  ]);
  expect('69a. gate works WITHOUT godmode-mode.js: unverified → BLOCK (fail-safe, not crash)', runAt(fblock), true);
  expect('69b. gate works WITHOUT godmode-mode.js: verified re-read → ALLOW', runAt(fallow), false);
}

// ====================================================================================
// ===== GODMONITOR: mode health / drift / integrity guardian =========================
// ====================================================================================
const MON_HOOK = `${HOOKS}/godmonitor.js`;
const MON_CLI = path.resolve(HOOKS, '..', 'godmonitor.mjs').replace(/\\/g, '/');
function buildMonHome(name, { mode = null, withModes = true, corrupt = null, removeFile = null } = {}) {
  const h = `${FIX}/${name}`;
  fs.rmSync(h, { recursive: true, force: true });
  fs.mkdirSync(`${h}/.claude/hooks`, { recursive: true });
  for (const f of ['godmode-mode.js', 'block-unverified-completion.js', 'inject-deterministic-contract.js', 'inject-anti-drift.js', 'godmode-gate.mjs', 'godmonitor.js', 'godmonitor-core.js', 'godimprove-core.js'])
    fs.copyFileSync(`${HOOKS}/${f}`, `${h}/.claude/hooks/${f}`);
  fs.writeFileSync(`${h}/.claude/deterministic-contract.md`, 'base contract');
  if (withModes) fs.cpSync(MODES_DIR, `${h}/.claude/modes`, { recursive: true });
  if (mode) fs.writeFileSync(`${h}/.claude/godmode-mode`, mode + '\n');
  fs.writeFileSync(`${h}/.claude/godmode-active`, '');
  if (corrupt) fs.writeFileSync(`${h}/.claude/modes/${corrupt}/gate.json`, '{ not valid json ,,,');
  if (removeFile) fs.rmSync(`${h}/.claude/${removeFile}`, { recursive: true, force: true });
  return h;
}
const monEnv = (home) => ({ ...process.env, DET_HOOKS_HOME: home, GODMODE_MODE: '', GODMODE_MODES_DIR: '' });
function runMonitor(home, cwd, source) { const payload = { hook_event_name: 'SessionStart' }; if (cwd !== undefined) payload.cwd = cwd; if (source !== undefined) payload.source = source; let o = ''; try { o = execFileSync('node', [MON_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: monEnv(home) }); } catch (e) { o = e.stdout || ''; } return o; }
function monCtx(out) { try { return JSON.parse(out).hookSpecificOutput.additionalContext; } catch (_) { return ''; } }
function monCheckExit(home) { try { execFileSync('node', [MON_CLI, 'check'], { encoding: 'utf8', env: monEnv(home) }); return 0; } catch (e) { return e.status == null ? -1 : e.status; } }
function runMonCli(home) { try { return execFileSync('node', [MON_CLI], { encoding: 'utf8', env: monEnv(home) }); } catch (e) { return e.stdout || ''; } }
function runDriftHook(home) { let o = ''; try { o = execFileSync('node', [DRIFT], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: monEnv(home) }); } catch (e) { o = e.stdout || ''; } try { return JSON.parse(o).hookSpecificOutput.additionalContext; } catch (_) { return ''; } }

// 70. healthy mode → confirmation injected + heartbeat written, no warning.
{
  const h = buildMonHome('mon_healthy', { mode: 'qa' });
  const ctx = monCtx(runMonitor(h));
  expect('70a. godmonitor: healthy qa mode → "intact" confirmation, no warning', /qa mode active and intact/i.test(ctx) && !/⚠/.test(ctx), true);
  expect('70b. godmonitor: heartbeat written to godmonitor.log', fs.existsSync(`${h}/.claude/godmonitor.log`), true);
}
// 71. DRIFT (requested mode whose folder is absent) → loud warning naming the lost mode.
{
  const ctx = monCtx(runMonitor(buildMonHome('mon_drift', { mode: 'qa', withModes: false })));
  expect('71. godmonitor: requested qa but no modes → ⚠ LOST PATH warning', /⚠/.test(ctx) && /qa/.test(ctx) && /did not load|lost path|not loaded/i.test(ctx), true);
}
// 72. general (no mode) at session start → ASKS the autopilot-vs-normal choice (no mode/health warning).
{
  const ctx = monCtx(runMonitor(buildMonHome('mon_general', { mode: null })));
  expect('72. godmonitor: general at session start → asks autopilot-or-normal (no mode/health warning)',
    /autopilot/i.test(ctx) && /autopilot on/.test(ctx) && !/⚠/.test(ctx) && !/active and intact/.test(ctx), true);
}
// 73. corrupt gate.json in the active mode → warning that the mode falls back to base.
{
  const ctx = monCtx(runMonitor(buildMonHome('mon_corrupt', { mode: 'qa', corrupt: 'qa' })));
  expect('73. godmonitor: corrupt qa/gate.json → ⚠ invalid-JSON warning', /⚠/.test(ctx) && /gate\.json/i.test(ctx) && /invalid/i.test(ctx), true);
}
// 74. CLI `check` exit code: 0 healthy, 1 broken (scriptable continuous monitoring).
{
  expect('74a. godmonitor CLI `check` → exit 0 when healthy', monCheckExit(buildMonHome('mon_chk_ok', { mode: 'qa' })), 0);
  expect('74b. godmonitor CLI `check` → exit 1 when drift/broken', monCheckExit(buildMonHome('mon_chk_bad', { mode: 'qa', withModes: false })), 1);
}
// 75. CLI report shows health + ALL-mode integrity ("monitors all the god modes").
{
  const rpt = runMonCli(buildMonHome('mon_report', { mode: 'qa' }));
  expect('75. godmonitor CLI report shows health + all-mode integrity', /GODMONITOR/.test(rpt) && /All modes/.test(rpt) && /\bqa\b/.test(rpt) && /\bdeveloper\b/.test(rpt), true);
}
// 76. per-turn drift guard in anti-drift: warns on drift, silent when healthy (zero extra tax).
{
  const d = runDriftHook(buildMonHome('mon_pt_drift', { mode: 'qa', withModes: false }));
  expect('76a. anti-drift: requested-but-unloaded mode → per-turn [godmonitor] warning', /\[godmonitor\]/.test(d) && /qa/.test(d), true);
  const ok = runDriftHook(buildMonHome('mon_pt_ok', { mode: 'qa' }));
  expect('76b. anti-drift: healthy mode → NO [godmonitor] prefix', /\[godmonitor\]/.test(ok), false);
  // 76c. per-turn INTEGRITY (improve godmonitor): an ACTIVE mode whose gate.json is corrupt mid-session →
  // a per-turn [godmonitor] warning that it is enforcing only the base gate — so monitoring covers the
  // active mode EVERY turn (catches a mid-session corruption or a switch onto a broken mode), not only
  // at SessionStart. Healthy modes (76b) stay silent, so this adds no normal-case token tax.
  const corruptActive = runDriftHook(buildMonHome('mon_pt_corrupt', { mode: 'developer', corrupt: 'developer' }));
  expect('76c. anti-drift: active mode with corrupt gate.json → per-turn integrity warning', /\[godmonitor\]/.test(corruptActive) && /developer mode is active but its files are not intact/.test(corruptActive) && /INVALID JSON/.test(corruptActive), true);
  // 76d. per-turn integrity covers SECONDARY modes too (multi-mode): corrupt a non-primary active mode →
  // still warned (the per-turn monitor now loops ALL active modes, matching SessionStart's healthCheck).
  const multiCorrupt = buildMonHome('mon_pt_multi', { withModes: true });
  fs.writeFileSync(`${multiCorrupt}/.claude/godmode-mode`, 'qa\ndeveloper\n'); // qa primary + developer secondary
  fs.writeFileSync(`${multiCorrupt}/.claude/modes/developer/gate.json`, '{ broken'); // corrupt the SECONDARY
  const md = runDriftHook(multiCorrupt);
  expect('76d. anti-drift: multi-mode → corrupt SECONDARY mode also warns (loops all active modes)', /\[godmonitor\]/.test(md) && /developer mode is active but its files are not intact/.test(md), true);
}

// ===== REGRESSION (godmonitor review): alias + custom-folder resolution / no false drift =====
// 77. resolveMode now honors an ALIAS (goddev -> developer), so GODMODE_MODE=goddev actually loads.
{
  expect('77. resolver: alias goddev → developer (loads the mode, not general)', runResolver({ GODMODE_MODE: 'goddev', GODMODE_MODES_DIR: MODES_DIR }), 'developer');
}
// 78. resolveMode loads a CUSTOM folder name (not in the alias table).
{
  fs.mkdirSync(`${FIX}/custommodes/myteam`, { recursive: true });
  expect('78. resolver: custom folder name loads (myteam)', runResolver({ GODMODE_MODE: 'myteam', GODMODE_MODES_DIR: `${FIX}/custommodes` }), 'myteam');
}
// 79. anti-drift: GODMODE_MODE alias loads the right reminder and does NOT false-fire the drift warning.
{
  const h = buildMonHome('mon_alias_env', { mode: null });
  let out = ''; try { out = execFileSync('node', [DRIFT], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, DET_HOOKS_HOME: h, GODMODE_MODE: 'goddev', GODMODE_MODES_DIR: '' } }); } catch (e) { out = e.stdout || ''; }
  let ctx = ''; try { ctx = JSON.parse(out).hookSpecificOutput.additionalContext; } catch (_) {}
  expect('79. anti-drift: GODMODE_MODE alias (goddev) → developer reminder, NO false [godmonitor]', /goddev/.test(ctx) && !/\[godmonitor\]/.test(ctx), true);
}
// 80. godmonitor: a present, valid CUSTOM mode folder is "intact" — no self-contradicting drift warning.
{
  const h = buildMonHome('mon_custom', { mode: null });
  fs.mkdirSync(`${h}/.claude/modes/myteam`, { recursive: true });
  fs.writeFileSync(`${h}/.claude/modes/myteam/contract.md`, '# custom contract');
  fs.writeFileSync(`${h}/.claude/modes/myteam/reminder.txt`, '[custom] prove it');
  fs.writeFileSync(`${h}/.claude/modes/myteam/gate.json`, JSON.stringify({ extraClaim: ['\\bship\\b'], reReadClears: true }));
  fs.writeFileSync(`${h}/.claude/godmode-mode`, 'myteam\n');
  const ctx = monCtx(runMonitor(h));
  expect('80. godmonitor: valid custom mode folder → intact, NO false drift', /myteam mode active and intact/i.test(ctx) && !/⚠/.test(ctx), true);
}
// 80b-c. Part B (WP-B.3): the per-turn injection carries the Kami pseudonym in the mode REMINDER,
// while the machine-parsed banner head "Active mode for this prompt: <id> (<trigger>)" stays a bare
// canonical id (godmonitor-server.mjs:297 must still extract it). Proves the display layer never pollutes
// the parsed protocol.
{
  const h = buildMonHome('mon_kami', { mode: 'developer' });
  let out = ''; try { out = execFileSync('node', [DRIFT], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'PB' }), encoding: 'utf8', env: { ...process.env, DET_HOOKS_HOME: h, GODMODE_MODE: 'developer', GODMODE_MODES_DIR: MODES_DIR } }); } catch (e) { out = e.stdout || ''; }
  let ctx = ''; try { ctx = JSON.parse(out).hookSpecificOutput.additionalContext; } catch (_) {}
  const bannerId = (ctx.match(/Active mode for this prompt:\s*([a-z-]+)/) || [])[1];
  expect('80b. WP-B.3: banner head stays a bare canonical id (machine-parseable), NOT decorated', bannerId, 'developer');
  expect('80c. WP-B.3: the mode reminder carries the Kami pseudonym (· Mahitotsu)', /· Mahitotsu/.test(ctx), true);
}

// ====================================================================================
// ===== AUTO-ROUTER (autopilot engine: the senseMode scorer — senses the task, switches modes) ====
// ====================================================================================
function senseSays(prompt) {
  try { return execFileSync('node', ['-e', `const s=require('./godsense-core.js').senseMode(${JSON.stringify(prompt)}); process.stdout.write(s?s.mode:'')`], { cwd: HOOKS, encoding: 'utf8' }).trim(); }
  catch (_) { return 'ERR'; }
}
function runAntiDrift(home, prompt, extraEnv = {}, cwd) {
  const payload = { hook_event_name: 'UserPromptSubmit', prompt };
  if (cwd !== undefined) payload.cwd = cwd; // engages path-gating (a scoped mode owns routing inside its dir)
  const input = JSON.stringify(payload);
  const env = { ...process.env, DET_HOOKS_HOME: home, GODMODE_MODE: '', GODMODE_MODES_DIR: '', ...extraEnv };
  let out = ''; try { out = execFileSync('node', [DRIFT], { input, encoding: 'utf8', env }); } catch (e) { out = e.stdout || ''; }
  try { return JSON.parse(out).hookSpecificOutput.additionalContext; } catch (_) { return ''; }
}
const readModeFile = (home) => { try { return fs.readFileSync(`${home}/.claude/godmode-mode`, 'utf8').trim(); } catch (_) { return ''; } };

// 81-83. scorer: confident signals route to the right mode; weak/ambiguous => NO switch.
{
  expect('81a. sense: "write unit tests for auth" → qa', senseSays('write unit tests for auth.js'), 'qa');
  expect('81b. sense: "fix the login bug, stack trace" → developer (debugger merged)', senseSays("fix the login bug, here's the stack trace"), 'developer');
  expect('81c. sense: "deploy the service to kubernetes" → ci-cd', senseSays('deploy the service to kubernetes'), 'ci-cd');
  expect('82a. sense: "analyze the sales dataset, show average" → data-analyst', senseSays('analyze the sales dataset and show the average'), 'data-analyst');
  expect('82b. sense: "fix the responsive css layout" → developer (ui-ux merged)', senseSays('fix the responsive css layout'), 'developer');
  expect('83a. sense: vague prompt → no switch (empty)', senseSays('help me with this thing'), '');
  expect('83b. sense: ambiguous "research the bug" (tie) → no switch', senseSays('research the bug'), '');
}
// ===== AUTO-PILOT: the SINGLE auto-routing switch (godsense + godsession were MERGED into it) =====
// 84. autopilot ON + a qa-signal prompt → auto-switches to qa AND announces it.
{
  const h = buildMonHome('sense_on', { mode: null }); fs.writeFileSync(`${h}/.claude/godmode-autosession`, 'enabled\n');
  const ctx = runAntiDrift(h, 'please write unit tests with coverage for the auth module');
  expect('84. autopilot ON + qa task → switches to qa + [autopilot] note', /\[autopilot\]/.test(ctx) && /godqa/.test(ctx) && readModeFile(h) === 'qa', true);
}
// 85. autopilot OFF (default) → never auto-routes, no note.
{
  const h = buildMonHome('sense_off', { mode: null });
  const ctx = runAntiDrift(h, 'please write unit tests with coverage for the auth module');
  expect('85. autopilot OFF → no switch, no [autopilot] (stays general)', !/\[autopilot\]/.test(ctx) && readModeFile(h) === '', true);
}
// 86. an explicit `godmode:` keyword WINS over autopilot (no auto-switch that turn).
{
  const h = buildMonHome('sense_explicit', { mode: null });
  fs.writeFileSync(`${h}/.claude/godmode-autosession`, 'enabled\n'); fs.writeFileSync(`${h}/.claude/godmode-keywords`, 'enabled\n');
  const ctx = runAntiDrift(h, 'godmode:debugger and also write unit tests with coverage');
  // godmode:debugger canonicalizes to developer (debugger folded in); the keyword still beats autopilot routing.
  expect('86. explicit godmode: keyword beats autopilot', readModeFile(h) === 'developer' && !/\[autopilot\]/.test(ctx) && /goddev/.test(ctx), true);
}
// 87-88. CLI toggle: autopilot on/off (the single auto-routing switch).
{
  const h = `${FIX}/sensecli`;
  const env = { ...process.env, DET_HOOKS_HOME: h, GODMODE_MODE: '' };
  try { execFileSync('node', [CLI, 'autopilot', 'on'], { encoding: 'utf8', env }); } catch (_) {}
  expect('87. CLI: `autopilot on` creates godmode-autosession + arms the layer', fs.existsSync(`${h}/.claude/godmode-autosession`) && fs.existsSync(`${h}/.claude/godmode-active`), true);
  try { execFileSync('node', [CLI, 'autopilot', 'off'], { encoding: 'utf8', env }); } catch (_) {}
  expect('88. CLI: `autopilot off` removes godmode-autosession', fs.existsSync(`${h}/.claude/godmode-autosession`), false);
}

// ===== AUTO-PILOT banners + the removed sense/session subcommands =====
// 89. the godmode-autosession sentinel enables auto-routing → anti-drift switches on a qa prompt.
{
  const h = buildMonHome('session_sense', { mode: null }); fs.writeFileSync(`${h}/.claude/godmode-autosession`, 'enabled\n');
  const ctx = runAntiDrift(h, 'write unit tests with coverage for the auth module');
  expect('89. autopilot ON enables auto-routing → switches to qa', /\[autopilot\]/.test(ctx) && readModeFile(h) === 'qa', true);
}
// 90. godmonitor announces the [autopilot] banner at SessionStart (even while still in general).
{
  const h = buildMonHome('session_banner', { mode: null }); fs.writeFileSync(`${h}/.claude/godmode-autosession`, 'enabled\n');
  expect('90. godmonitor announces auto-routing banner at session start (autopilot)', /\[autopilot\]/.test(monCtx(runMonitor(h))), true);
}
// 91. autopilot OFF at session start → ASKS the autopilot-vs-normal choice.
{
  const ctx = monCtx(runMonitor(buildMonHome('session_off', { mode: null })));
  expect('91. godmonitor: general + autopilot off → asks autopilot-or-normal', /autopilot/i.test(ctx) && /autopilot on/.test(ctx), true);
}
// 91b. a mid-session 'compact' SessionStart does NOT nag the choice (general + off + compact → silent).
{
  expect('91b. godmonitor: source=compact (general, off) → SILENT (no nag on compaction)',
    runMonitor(buildMonHome('session_compact', { mode: null }), undefined, 'compact').trim(), '');
}
// 91c. on RESUME the choice IS asked (the request is "new OR resumed session").
{
  const ctx = monCtx(runMonitor(buildMonHome('session_resume', { mode: null }), undefined, 'resume'));
  expect('91c. godmonitor: source=resume → asks autopilot-or-normal', /autopilot/i.test(ctx) && /autopilot on/.test(ctx), true);
}
// 92. the OLD `sense` / `session` subcommands were REMOVED (collapsed into autopilot) → error cleanly,
// and write NONE of the old sentinels.
{
  const h = `${FIX}/sessioncli`;
  const env = { ...process.env, DET_HOOKS_HOME: h, GODMODE_MODE: '' };
  let outSense = '', outSession = '';
  try { outSense = execFileSync('node', [CLI, 'sense', 'on'], { encoding: 'utf8', env }); } catch (e) { outSense = (e.stdout || '') + (e.stderr || ''); }
  try { outSession = execFileSync('node', [CLI, 'session', 'on'], { encoding: 'utf8', env }); } catch (e) { outSession = (e.stdout || '') + (e.stderr || ''); }
  expect('92a. removed: `sense on` → Unknown mode (merged into autopilot)', /Unknown mode/.test(outSense), true);
  expect('92b. removed: `session on` → Unknown mode (merged into autopilot)', /Unknown mode/.test(outSession), true);
  expect('92c. removed subcommands write no godmode-sense/godmode-session sentinel', !fs.existsSync(`${h}/.claude/godmode-sense`) && !fs.existsSync(`${h}/.claude/godmode-session`), true);
}

// ===== REGRESSION (deep review fixes): scorer, explicit-pin, validate-loads, banner, dual-flag =====
// 93-95. scorer fixes (debug verb visible, grouped weak signals accumulate, bare query demoted).
{
  expect('93. sense: "debug the login flow" → developer (debugger merged)', senseSays('debug the login flow'), 'developer');
  expect('94. sense: multi-symptom "crashes with an exception and throws errors" → developer (debugger merged)', senseSays('the app crashes with an exception and throws errors'), 'developer');
  expect('95. sense: bare "optimize this query" → no switch (query is now weak)', senseSays('optimize this query'), '');
}
// 96. explicit PIN: a manual mode survives an auto-routing-signal prompt (explicit wins ACROSS turns).
{
  const h = buildMonHome('pin_manual', { mode: null });
  fs.writeFileSync(`${h}/.claude/godmode-autosession`, 'enabled\n');
  fs.writeFileSync(`${h}/.claude/godmode-mode`, 'developer\n');
  fs.writeFileSync(`${h}/.claude/godmode-explicit`, 'explicit\n'); // a prior explicit pick
  const ctx = runAntiDrift(h, 'write unit tests with coverage for the parser');
  expect('96. explicit pin: autopilot does NOT override a pinned manual mode', !/\[autopilot\]/.test(ctx) && readModeFile(h) === 'developer', true);
}
// 97. validate-loads: autopilot skips a sensed mode whose folder is missing (no contradiction, no data loss).
{
  const h = buildMonHome('sense_unloadable', { mode: null });
  fs.writeFileSync(`${h}/.claude/godmode-autosession`, 'enabled\n');
  fs.rmSync(`${h}/.claude/modes/qa`, { recursive: true, force: true });
  const ctx = runAntiDrift(h, 'please write unit tests with coverage');
  // A CONFIDENT qa signal makes routeMode return 'qa', but qa's folder is gone, so inject-anti-drift refuses
  // to switch to an unloadable mode — it does NOT fall back to the default (that path is only for UNsignalled
  // prompts) — so it stays general, with no [autopilot]/[godmonitor] contradiction.
  expect('97. validate-loads: unloadable sensed mode → no switch, no [autopilot]/[godmonitor] contradiction', !/\[autopilot\]/.test(ctx) && !/\[godmonitor\]/.test(ctx) && readModeFile(h) === '', true);
}
// 98. unknown `godmode:` keyword is treated as explicit intent (autopilot does NOT override it).
{
  const h = buildMonHome('kw_unknown', { mode: null });
  fs.writeFileSync(`${h}/.claude/godmode-keywords`, 'enabled\n'); fs.writeFileSync(`${h}/.claude/godmode-autosession`, 'enabled\n');
  const ctx = runAntiDrift(h, 'godmode:frontend make the button responsive with css');
  expect('98. unknown godmode: keyword → noted + autopilot suppressed', /\[godmode\] unknown/.test(ctx) && !/\[autopilot\]/.test(ctx) && readModeFile(h) === '', true);
}
// 99. with autopilot OFF and a mode explicitly set, the per-turn hook does NOT auto-route (no churn note).
{
  const h = buildMonHome('no_churn', { mode: null });
  fs.writeFileSync(`${h}/.claude/godmode-mode`, 'developer\n'); fs.writeFileSync(`${h}/.claude/godmode-explicit`, 'explicit\n');
  const ctx = runAntiDrift(h, 'please write unit tests with coverage'); // a qa-signal prompt, but autopilot OFF
  expect('99. autopilot OFF → no auto-route note, explicit mode kept', !/\[autopilot\]/.test(ctx) && readModeFile(h) === 'developer', true);
}
// 100. CLI: `autopilot off` cleanly disables auto-routing — there is no longer a second flag to warn about.
{
  const h = `${FIX}/dualflag`;
  const env = { ...process.env, DET_HOOKS_HOME: h, GODMODE_MODE: '' };
  try { execFileSync('node', [CLI, 'autopilot', 'on'], { encoding: 'utf8', env }); } catch (_) {}
  let out = ''; try { out = execFileSync('node', [CLI, 'autopilot', 'off'], { encoding: 'utf8', env }); } catch (e) { out = e.stdout || ''; }
  expect('100. CLI: `autopilot off` cleanly disables (no residual sense/session flag to warn about)', /Auto-pilot OFF/i.test(out) && !fs.existsSync(`${h}/.claude/godmode-autosession`), true);
}

// ====================================================================================
// ===== GODDEV BOUNDARY GUARD: PreToolUse ask-before-sensitive-command =================
// confirm-sensitive-commands.js returns permissionDecision:"ask" (forces a user confirm — NOT a hard
// deny, NOT a block of the proof gate). Scoped BY DATA: only developer/gate.json ships confirmCommands,
// so general/ci-cd/etc. are no-ops. ci-cd MUST stay free to deploy. Fail-OPEN on bad input.
// ====================================================================================
const GUARD = `${HOOKS}/confirm-sensitive-commands.js`;
function runGuard(command, { mode = 'developer', tool = 'Bash', cwd } = {}) {
  const payload = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } };
  if (cwd !== undefined) payload.cwd = cwd; // engages path-gating: a scoped mode's confirmCommands apply only in its dir
  const input = JSON.stringify(payload);
  const env = { ...process.env, GODMODE_MODE: mode, GODMODE_MODES_DIR: MODES_DIR, DET_HOOKS_HOME: FIX };
  let out = '';
  try { out = execFileSync('node', [GUARD], { input, encoding: 'utf8', env }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return /"permissionDecision"\s*:\s*"ask"/.test(out);
}
// 101-102. git push (incl. force, incl. inside a compound chain) → ASK.
expect('101. goddev: `git push` → ASK', runGuard('git push'), true);
expect('102. goddev: `git add -A && git commit -m x && git push --force` → ASK', runGuard('git add -A && git commit -m "x" && git push --force origin main'), true);
// 103-104. local git that the contract EXPLICITLY allows → must NOT ask.
expect('103. goddev: `git add -A && git commit -m wip` (no push) → ALLOW', runGuard('git add -A && git commit -m "wip"'), false);
expect('104. goddev: `git status` → ALLOW', runGuard('git status'), false);
// 105. the proof gate\'s OWN verification commands must NEVER be intercepted.
expect('105a. goddev: `npm test` → ALLOW (never block verification)', runGuard('npm test'), false);
expect('105b. goddev: `npm run build` → ALLOW', runGuard('npm run build'), false);
// 106-107. infra: mutating verbs ask; read-only/plan do not.
expect('106a. goddev: `terraform apply -auto-approve` → ASK', runGuard('terraform apply -auto-approve'), true);
expect('106b. goddev: `terraform plan` → ALLOW', runGuard('terraform plan'), false);
expect('107a. goddev: `kubectl apply -f prod.yaml` → ASK', runGuard('kubectl apply -f k8s/prod.yaml'), true);
expect('107b. goddev: `kubectl get pods` → ALLOW', runGuard('kubectl get pods -n prod'), false);
// 108. deploy / publish.
expect('108a. goddev: `npm run deploy` → ASK', runGuard('npm run deploy'), true);
expect('108b. goddev: `vercel --prod` → ASK', runGuard('vercel --prod'), true);
expect('108c. goddev: `docker build .` → ALLOW', runGuard('docker build -t app .'), false);
expect('108d. goddev: `docker push registry/app` → ASK', runGuard('docker push registry/app:latest'), true);
expect('108e. goddev: `npm publish` → ASK', runGuard('npm publish'), true);
expect('108f. goddev: `gh pr create` → ASK', runGuard('gh pr create --fill'), true);
// 109. secret / credential files: secrets ask; templates and ordinary files do not.
expect('109a. goddev: `cat .env` → ASK', runGuard('cat .env'), true);
expect('109b. goddev: `type .env.production` → ASK', runGuard('type .env.production'), true);
expect('109c. goddev: `cat .env.example` → ALLOW (template, not a secret)', runGuard('cat .env.example'), false);
expect('109d. goddev: `cat README.md` → ALLOW', runGuard('cat README.md'), false);
expect('109e. goddev: `cp ~/.ssh/id_rsa /tmp` → ASK', runGuard('cp ~/.ssh/id_rsa /tmp/k'), true);
// 110-111. WP-1.4: git push is now guarded in EVERY mode via the BASE guard (the user is push-forbidden
// everywhere), with ci-cd (godship) the sole opt-out (its job is to ship). Mode gate.json still ADDS
// mode-specific guards (developer/web-builder: publish/docker).
expect('110. general: `git push` → ASK (base guard covers every mode, WP-1.4)', runGuard('git push', { mode: 'general' }), true);
expect('110b. qa: `git push` → ASK (base guard, not just developer)', runGuard('git push', { mode: 'qa' }), true);
expect('110c. researcher: `git push` → ASK (base guard)', runGuard('git push', { mode: 'researcher' }), true);
// 110d-g. WP-1.4 corrected regex: the `-C <dir>` / `-c k=v` option-arg bypasses (incl. quoted paths with
// spaces) are now CAUGHT in general mode; benign git that merely mentions "push" is NOT.
expect('110d. general: `git -C /repo push` → ASK (bypass closed)', runGuard('git -C /repo push origin main', { mode: 'general' }), true);
expect('110e. general: `git -c core.sshCommand=x push` → ASK (bypass closed)', runGuard('git -c core.sshCommand=x push', { mode: 'general' }), true);
expect('110f. general: `git -C "C:/My Repo" push` (quoted path w/ space) → ASK (residual bypass closed)', runGuard('git -C "C:/My Repo" push', { mode: 'general' }), true);
expect('110g. general: `git commit -m "add push support"` → ALLOW (benign, not a push)', runGuard('git commit -m "add push support"', { mode: 'general' }), false);
expect('111a. ci-cd: `git push` → ALLOW (godship is the SOLE opt-out — must not be guarded)', runGuard('git push', { mode: 'ci-cd' }), false);
expect('111b. ci-cd: `kubectl apply -f x` → ALLOW (deploying is its job)', runGuard('kubectl apply -f x.yaml', { mode: 'ci-cd' }), false);
// 112-113. PowerShell parity; non-shell tools are ignored (defensive — matcher already filters).
expect('112. goddev: `git push` via PowerShell tool → ASK', runGuard('git push', { tool: 'PowerShell' }), true);
expect('113. goddev: non-shell tool (Read) → ALLOW (guard only inspects shells)', runGuard('git push', { tool: 'Read' }), false);
// 114. unparsable input → ALLOW (fail-open, emits nothing).
{
  const env = { ...process.env, GODMODE_MODE: 'developer', GODMODE_MODES_DIR: MODES_DIR, DET_HOOKS_HOME: FIX };
  let out = ''; try { out = execFileSync('node', [GUARD], { input: 'not json', encoding: 'utf8', env }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  expect('114. guard: unparsable input → ALLOW (fail-open, no output)', out.trim(), '');
}
// 115. END-TO-END through the opt-in wrapper: DORMANT → ALLOW even on `git push`; ACTIVE+developer → ASK.
function runGuardWrapped(command, { active }) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const env = { ...process.env, GODMODE_ACTIVE: active ? '1' : '0', GODMODE_PERF: '0', GODMODE_MODE: 'developer', GODMODE_MODES_DIR: MODES_DIR, DET_HOOKS_HOME: FIX };
  let out = ''; try { out = execFileSync('node', [WRAP, GUARD], { input, encoding: 'utf8', env }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return /"permissionDecision"\s*:\s*"ask"/.test(out);
}
expect('115a. wrapper DORMANT: `git push` → ALLOW (layer off, no prompt)', runGuardWrapped('git push', { active: false }), false);
expect('115b. wrapper ACTIVE + developer: `git push` → ASK (transparent relay)', runGuardWrapped('git push', { active: true }), true);

// ====================================================================================
// ===== FLUSH-RACE SETTLE FIX (issue B): trailing NON-conversational records (system / =
// ===== queue / permission / ...) appended after the closing message must not defeat    =
// ===== settle-detection. EMPIRICAL: these accounted for ~all real UNSETTLED reads — the =
// ===== closing text was already present, but the old "is the LAST LINE assistant text?" =
// ===== check missed it and burned the whole ~1.2s flush budget for nothing.             =
// ====================================================================================
// filter(Boolean) drops the trailing '' from the final newline — otherwise snapshotting a raw line
// count and slicing it would be off-by-one (the first appended line lands on the old '' index).
const auditLines = () => { try { return fs.readFileSync(`${FIX}/.claude/hook-audit.log`, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
const trailingMeta = [
  { type: 'system', subtype: 'hook_feedback', content: 'a hook said something' },
  { type: 'queue', content: 'queued user message' },
  { type: 'permission', content: 'permission record' },
];
// 147. closing claim followed by trailing meta → still BLOCKs AND now reads SETTLED (no wasted budget).
{
  const f = writeFixture('settle_trailing_meta_block', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Done — fixed the bug, it works now.'),
    ...trailingMeta,
  ]);
  const before = auditLines().length;
  const r = runGate(f);
  const fresh = auditLines().slice(before).join('\n');
  expect('147a. trailing system/queue/permission after closing text → still BLOCK', r.blocked, true);
  expect('147b. trailing meta no longer forces UNSETTLED → read SETTLED (flush-fix)', /read settled/.test(fresh) && !/UNSETTLED/.test(fresh), true);
}
// 148. the ALLOW path is equally unaffected (a verified re-read still clears AND settles past the meta).
{
  const f = writeFixture('settle_trailing_meta_allow', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstTool('Read', { file_path: WP }),
    toolResult(),
    asstText('Done — re-read it, the fix is present and correct.'),
    ...trailingMeta,
  ]);
  const before = auditLines().length;
  const r = runGate(f);
  const fresh = auditLines().slice(before).join('\n');
  expect('148a. trailing meta on a verified turn → still ALLOW', r.blocked, false);
  expect('148b. trailing meta on a verified turn → read SETTLED', /read settled/.test(fresh) && !/UNSETTLED/.test(fresh), true);
}

// ====================================================================================
// ===== IN-PROCESS DISPATCH (issue A): the opt-in wrapper now require()s each hook and  =
// ===== calls its exported run(data)→string IN-PROCESS (no 2nd `node`). It must produce  =
// ===== the SAME decision as the direct CLI path, both directions.                       =
// ====================================================================================
// 149. wrapper(in-process) decision === direct-CLI decision, for both a block and a verified-allow turn.
{
  const fBlock = writeFixture('inproc_equiv_block', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Done, it works.'),
  ]);
  const fAllow = writeFixture('inproc_equiv_allow', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstTool('Read', { file_path: WP }),
    toolResult(),
    asstText('Done — re-read it, the fix is present.'),
  ]);
  expect('149a. in-process wrapper BLOCKs exactly where the CLI gate does', runWrappedGate(fBlock, { active: true }), runGate(fBlock).blocked);
  expect('149b. in-process wrapper ALLOWs exactly where the CLI gate does', runWrappedGate(fAllow, { active: true }), runGate(fAllow).blocked);
  expect('149c. (sanity) block case truly blocks, allow case truly allows', runGate(fBlock).blocked === true && runGate(fAllow).blocked === false, true);
}

// ====================================================================================
// ===== GENUINE FLUSH RACE (the OTHER half of issue B): a turn whose closing assistant  =
// ===== message is NOT flushed yet (ends on a tool_result) genuinely cannot settle — the =
// ===== gate waits the full budget, logs UNSETTLED, and fails OPEN (under-enforces). This =
// ===== is the intentional fail-safe the budget guards; distinct from the 147/148 fix.    =
// ====================================================================================
// 150. ends on a tool_result, no closing assistant text → fail-open ALLOW + UNSETTLED logged.
{
  const f = writeFixture('genuine_flush_race', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(), // turn ends here; the closing assistant message is not in the transcript yet
  ]);
  const before = auditLines().length;
  const r = runGate(f);
  const fresh = auditLines().slice(before).join('\n');
  expect('150a. unflushed closing message (ends on tool_result) → fail-open ALLOW', r.blocked, false);
  expect('150b. ...and the read is logged UNSETTLED (budget expired), not settled', /UNSETTLED\(flush budget expired\)/.test(fresh) && !/read settled/.test(fresh), true);
}

// ====================================================================================
// ===== goddev gate.json WIDENING (Tier 1) + confirmCommands over-fire fixes (Tier 2) ==
// Patterns empirically pre-validated; these lock the behavior into the regression suite.
// ====================================================================================
// 151. new completion-claim phrasings trip the goddev gate (the general floor does NOT have them).
{
  const mk = (txt) => writeFixture('goddev_claim_' + txt.replace(/\W+/g, '_').slice(0, 18), [
    userPrompt('do the thing'), asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(), asstText(txt),
  ]);
  const fWired = mk("I've wired up the /checkout route to the payment handler.");
  expect('151a. goddev: "wired up" claim, no proof → BLOCK', runGate(fWired, { mode: 'developer' }).blocked, true);
  expect('151b. general: "wired up" is not a base claim → ALLOW (proves it is mode-specific)', runGate(fWired).blocked, false);
  expect('151c. goddev: "good to go" claim, no proof → BLOCK', runGate(mk('Good to go — the migration is in the repo.'), { mode: 'developer' }).blocked, true);
  expect('151d. goddev: "all green" claim, no proof → BLOCK', runGate(mk('all green on my end.'), { mode: 'developer' }).blocked, true);
  expect('151e. goddev: "lgtm" claim, no proof → BLOCK', runGate(mk('LGTM, shipping it.'), { mode: 'developer' }).blocked, true);
}
// 152. benign closings that LOOK similar do NOT trip the goddev gate (no false bounce).
{
  const mkB = (txt) => writeFixture('goddev_benign_' + txt.replace(/\W+/g, '_').slice(0, 14), [
    userPrompt('do the thing'), asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(), asstText(txt),
  ]);
  expect('152a. goddev: "Hook up the debugger when you can" → ALLOW (imperative, not a claim)', runGate(mkB('I made the change. Hook up the debugger when you can to see more.'), { mode: 'developer' }).blocked, false);
  expect('152b. goddev: "Good to know the API changed" → ALLOW (verb not in the ship set)', runGate(mkB('Edited the file. Good to know the API changed — take a look.'), { mode: 'developer' }).blocked, false);
}
// 153. new build/test commands CLEAR a goddev claim post-edit (general floor does NOT recognize them).
{
  const mkV = (cmd, name) => writeFixture('goddev_cmd_' + name, [
    userPrompt('finish it'), asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('Bash', { command: cmd }), toolResult(), asstText('Done — builds clean.'),
  ]);
  const fGradlew = mkV('./gradlew test', 'gradlew');
  expect('153a. goddev: post-edit ./gradlew test → ALLOW (mode adds gradlew)', runGate(fGradlew, { mode: 'developer' }).blocked, false);
  expect('153b. general: ./gradlew test unknown → BLOCK (floor unchanged)', runGate(fGradlew).blocked, true);
  expect('153c. goddev: post-edit `make test` → ALLOW', runGate(mkV('make test', 'make'), { mode: 'developer' }).blocked, false);
  expect('153d. goddev: post-edit `bun test` → ALLOW', runGate(mkV('bun test', 'bun'), { mode: 'developer' }).blocked, false);
  expect('153e. goddev: post-edit `bundle exec rspec` → ALLOW', runGate(mkV('bundle exec rspec', 'rspec'), { mode: 'developer' }).blocked, false);
}
// 154. confirmCommands OVER-FIRE fixes: benign git/deploy-ish commands no longer ASK.
{
  expect('154a. goddev: `git commit -m "fix the push handler"` → ALLOW (no longer over-fires)', runGuard('git commit -m "fix the push handler"'), false);
  expect('154b. goddev: `git checkout -b push-notifications` → ALLOW', runGuard('git checkout -b push-notifications'), false);
  expect('154c. goddev: `cat deploy.sh` (reading, not running) → ALLOW', runGuard('cat deploy.sh'), false);
  expect('154d. goddev: `npm run predeploy` (lifecycle hook, not deploy) → ALLOW', runGuard('npm run predeploy'), false);
}
// 155. ...but real pushes/deploys STILL ASK (the tightening did not under-catch the genuine cases).
{
  expect('155a. goddev: `git push` still → ASK', runGuard('git push'), true);
  expect('155b. goddev: `… && git push --force` still → ASK', runGuard('git add -A && git commit -m "x" && git push --force origin main'), true);
  expect('155c. goddev: `./deploy.sh` (executing) → ASK', runGuard('./deploy.sh'), true);
  expect('155d. goddev: `bash deploy.sh` → ASK', runGuard('bash deploy.sh'), true);
  expect('155e. goddev: `npm run deploy` still → ASK', runGuard('npm run deploy'), true);
}

// ====================================================================================
// ===== PER-SESSION ISOLATION + MULTI-MODE + PER-SESSION SHARED MEMORY ================
// The session system: two concurrent sessions run any modes WITHOUT conflict; a session may run
// SEVERAL modes at once (the gate enforces the UNION, strictest re-read rule wins); each session has
// its OWN shared memory isolated from others. Hooks key off payload.session_id; the CLI keys off
// CLAUDE_CODE_SESSION_ID. With NO session id everything falls back to the legacy GLOBAL files (proven
// unchanged by every test above, which pass no session id).
// ====================================================================================
{
  const home = `${FIX}/sessionsys`; fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(`${home}/.claude`, { recursive: true });
  const baseEnv = () => ({ ...process.env, DET_HOOKS_HOME: home, GODMODE_MODE: '', GODMODE_MODES_DIR: MODES_DIR });
  const cliS = (args, sid) => { const env = baseEnv(); if (sid) env.CLAUDE_CODE_SESSION_ID = sid; try { return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
  const rModes = (sid, cwd = '') => { const code = `const r=require(${JSON.stringify(HOOKS + '/godmode-mode.js')}); process.stdout.write(JSON.stringify(r.resolveModes(process.env.DET_HOOKS_HOME, ${JSON.stringify(cwd)}, ${JSON.stringify(sid)})))`; try { return JSON.parse(execFileSync('node', ['-e', code], { encoding: 'utf8', env: baseEnv() })); } catch (_) { return ['ERR']; } };
  const antidriftS = (sid, prompt = 'do the thing') => { const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid }); try { const o = execFileSync('node', [DRIFT], { input, encoding: 'utf8', env: baseEnv() }); return JSON.parse(o).hookSpecificOutput.additionalContext; } catch (_) { return ''; } };
  const gateBlocksS = (tp, sid) => { const payload = { hook_event_name: 'Stop', transcript_path: tp, stop_hook_active: false, session_id: sid }; let out = ''; try { out = execFileSync('node', [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env: baseEnv() }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); } return /"decision"\s*:\s*"block"/.test(out); };

  // ---- isolation: two sessions, two modes, no cross-talk, no global write ----
  cliS(['goddev'], 'A'); cliS(['godqa'], 'B');
  expect('200. session A select → resolves developer (its own overlay)', JSON.stringify(rModes('A')), JSON.stringify(['developer']));
  expect('201. session B select → resolves qa (A did NOT flip B)', JSON.stringify(rModes('B')), JSON.stringify(['qa']));
  expect('202. an unseen session → general (global fallback)', JSON.stringify(rModes('Z')), JSON.stringify(['general']));
  expect('203. a session select does NOT write the global godmode-mode', fs.existsSync(`${home}/.claude/godmode-mode`), false);

  // ---- multiple modes in ONE session; the gate enforces the UNION ----
  cliS(['add', 'goddata'], 'A');
  expect('204. add → session A runs BOTH developer + data-analyst', JSON.stringify(rModes('A')), JSON.stringify(['developer', 'data-analyst']));
  const fReread = writeFixture('sess_multi_reread', [
    userPrompt('build it and analyze'),
    asstTool('Edit', { file_path: 'C:/work/x.py', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Read', { file_path: 'C:/work/x.py' }),
    toolResult(),
    asstText('Done — analyzed, it works.')
  ]);
  expect('205. multi-mode union: a re-read does NOT clear (data-analyst strictness in the union) → BLOCK', gateBlocksS(fReread, 'A'), true);
  cliS(['drop', 'goddata'], 'A');
  expect('206. drop → session A back to a single mode (developer)', JSON.stringify(rModes('A')), JSON.stringify(['developer']));

  // ---- per-session shared memory: isolated; surfaced to that session only ----
  cliS(['mem', 'set', 'secret', 'vaultX'], 'A');
  expect('207. session A reads its OWN shared memory', cliS(['mem', 'get', 'secret'], 'A').trim(), 'vaultX');
  expect('208. session B does NOT see session A memory (isolated)', /no value/.test(cliS(['mem', 'get', 'secret'], 'B')), true);
  const adA = antidriftS('A');
  expect('209. anti-drift(A): names developer AND surfaces A\'s shared memory', /Active mode for this prompt: developer/.test(adA) && /session-mem/.test(adA) && /secret/.test(adA), true);
  const adB = antidriftS('B');
  expect('210. anti-drift(B): names qa, no developer, NO leak of A\'s memory', /Active mode for this prompt: qa/.test(adB) && !/developer/.test(adB) && !/secret/.test(adB), true);

  // ---- autopilot routes per-session; an explicit pin in another session is untouched ----
  cliS(['autopilot', 'on', '--session', 'C'], 'C'); // per-session autopilot overlay for C only
  const adC = antidriftS('C', 'please write unit tests with coverage for the auth module');
  expect('211. autopilot(C): auto-switches C to qa (writes C\'s overlay)', /\[autopilot\]/.test(adC) && JSON.stringify(rModes('C')) === JSON.stringify(['qa']), true);
  expect('212. autopilot(C): did NOT change session A (still developer)', JSON.stringify(rModes('A')), JSON.stringify(['developer']));

  // ---- per-session `off` overrides a global default-on; other sessions stay armed ----
  fs.writeFileSync(`${home}/.claude/godmode-active`, ''); // a global always-on default
  cliS(['off'], 'A');
  const armCode = `const s=require(${JSON.stringify(HOOKS + '/godstate-core.js')}); process.stdout.write(JSON.stringify([s.armed(process.env.DET_HOOKS_HOME,'A'), s.armed(process.env.DET_HOOKS_HOME,'Z')]))`;
  let arm = []; try { arm = JSON.parse(execFileSync('node', ['-e', armCode], { encoding: 'utf8', env: baseEnv() })); } catch (_) {}
  expect('213. session A `off` → dormant despite a global active (overlay overrides)', arm[0], false);
  expect('214. an unseen session stays armed via the global default', arm[1], true);

  // ---- --global targets the legacy seed default, separate from any session ----
  cliS(['godbug', '--global'], 'A'); // even with a session env present, --global writes the global file
  expect('215. --global writes the global godmode-mode (seed default)', fs.existsSync(`${home}/.claude/godmode-mode`), true);
  expect('216. --global did NOT change session B', JSON.stringify(rModes('B')), JSON.stringify(['qa']));

  // ---- session id is sanitized (no path traversal into the store) ----
  const sanCode = `const s=require(${JSON.stringify(HOOKS + '/godstate-core.js')}); process.stdout.write(JSON.stringify([s.sanitizeSid('../evil'), s.sanitizeSid('a/b'), s.sanitizeSid('good-123'), s.sessionDir(process.env.DET_HOOKS_HOME,'../evil')]))`;
  let san = []; try { san = JSON.parse(execFileSync('node', ['-e', sanCode], { encoding: 'utf8', env: baseEnv() })); } catch (_) {}
  expect('217. sanitizeSid rejects traversal/path chars, keeps safe ids; no dir for a bad id', san[0] === '' && san[1] === '' && san[2] === 'good-123' && san[3] === '', true);
}

// ====================================================================================
// ===== REGRESSION (adversarial review fixes): pin isolation, verify-tool laundering, ==
// ===== GC of live sessions, no-session memory leak, digest bound =====================
// ====================================================================================
{
  const home = `${FIX}/sessionfix`; fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(`${home}/.claude`, { recursive: true });
  fs.writeFileSync(`${home}/.claude/deterministic-contract.md`, 'base contract');
  const baseEnv = () => ({ ...process.env, DET_HOOKS_HOME: home, GODMODE_MODE: '', GODMODE_MODES_DIR: MODES_DIR });
  const cliS = (args, sid) => { const env = baseEnv(); if (sid) env.CLAUDE_CODE_SESSION_ID = sid; try { return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
  const rModes = (sid, cwd = '') => { const code = `const r=require(${JSON.stringify(HOOKS + '/godmode-mode.js')}); process.stdout.write(JSON.stringify(r.resolveModes(process.env.DET_HOOKS_HOME, ${JSON.stringify(cwd)}, ${JSON.stringify(sid)})))`; try { return JSON.parse(execFileSync('node', ['-e', code], { encoding: 'utf8', env: baseEnv() })); } catch (_) { return ['ERR']; } };
  const antidriftS = (sid, prompt) => { const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid }); try { const o = execFileSync('node', [DRIFT], { input, encoding: 'utf8', env: baseEnv() }); return JSON.parse(o).hookSpecificOutput.additionalContext; } catch (_) { return ''; } };
  const gateBlocksS = (tp, sid) => { const payload = { hook_event_name: 'Stop', transcript_path: tp, stop_hook_active: false, session_id: sid }; let out = ''; try { out = execFileSync('node', [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env: baseEnv() }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); } return /"decision"\s*:\s*"block"/.test(out); };

  // 218. FIX (review #1/#3): a GLOBAL explicit pin must NOT be inherited by a fresh session and freeze
  // its auto-routing. A fresh session with autopilot on must still route + fork its OWN overlay.
  cliS(['goddev', '--global']);                       // global mode=developer + a GLOBAL explicit pin
  cliS(['autopilot', 'on', '--session', 'F'], 'F');  // fresh session F: autopilot on, no own `mode` overlay yet
  const adF = antidriftS('F', 'please write unit tests with coverage for the auth module');
  expect('218. a global pin does NOT freeze a fresh session — autopilot fires + forks its own overlay', /\[autopilot\]/.test(adF) && JSON.stringify(rModes('F')) === JSON.stringify(['qa']), true);

  // 218d-e. SEAMLESS SWITCHING (end-to-end): under autopilot a confident signal switches the session's
  // mode mid-flight, and the GATE enforces the SWITCHED-IN mode's rules for that SAME session/turn — the
  // switch is persisted at UserPromptSubmit, so the Stop gate reads the new mode. (Proves the hooks on
  // different modes move together, not just the announcement.)
  cliS(['godreview'], 'SW');                                   // session SW currently in reviewer (pinned)
  cliS(['drop', 'godreview'], 'SW'); cliS(['autopilot', 'on', '--session', 'SW'], 'SW'); // un-pin + autopilot on for SW
  const adSW = antidriftS('SW', 'fix the responsive css layout bug');   // confident debug+UI signal → developer
  expect('218d. autopilot reroutes SW to developer on a confident signal (seamless switch)', /\[autopilot\]/.test(adSW) && JSON.stringify(rModes('SW')) === JSON.stringify(['developer']), true);
  // 218d2. on the SWITCH turn the NEW mode's FULL contract is injected (not just the terse reminder) — so a
  // mid-session switch is a real adoption of the new discipline, matching SessionStart/SubagentStart delivery.
  expect('218d2. mid-session switch injects the new mode\'s FULL contract this turn', /MODE SWITCHED to developer/.test(adSW) && /Deterministic Operating Contract — developer mode \(goddev\)/.test(adSW), true);
  // 218d3. a STEADY-STATE follow-up (no mode change) does NOT re-inject the contract (cost bounded to switch turns).
  const adSW2 = antidriftS('SW', 'keep going on that');
  expect('218d3. steady-state turn (no switch) does NOT re-inject the contract', /MODE SWITCHED/.test(adSW2), false);
  const fSW = writeFixture('seamless_gate', [
    userPrompt('fix it'), asstTool('Edit', { file_path: 'C:/work/x.tsx', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('Read', { file_path: 'C:/work/x.tsx' }), toolResult(), asstText('Fixed — looks responsive now.')]);
  expect('218e. the gate enforces the SWITCHED-IN mode same session (developer reReadClears:false → re-read does NOT clear → BLOCK)', gateBlocksS(fSW, 'SW'), true);

  // 219-221. FIX (review #2): a lenient mode's verify-TOOL must not LAUNDER a run-strict mode's claim.
  cliS(['godqa'], 'Q'); cliS(['add', 'godscout'], 'Q'); // qa (run-strict) + researcher (tool-as-proof)
  const fWebQA = writeFixture('fix_launder_qa_research', [
    userPrompt('test and research'), asstTool('Edit', { file_path: 'C:/work/x.test.js', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('WebSearch', { query: 'x' }), toolResult(), asstText('All green, coverage complete, no regressions. Done.')]);
  expect('219. qa+researcher: a WebSearch does NOT clear a qa "tests pass" claim → BLOCK (no laundering)', gateBlocksS(fWebQA, 'Q'), true);
  cliS(['goddata'], 'D'); cliS(['add', 'godscout'], 'D'); // data-analyst (run-strict) + researcher
  const fWebDA = writeFixture('fix_launder_da_research', [
    userPrompt('analyze and research'), asstTool('Edit', { file_path: 'C:/work/a.sql', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('WebSearch', { query: 'x' }), toolResult(), asstText('The data shows the total is 42. Done.')]);
  expect('220. data-analyst+researcher: a WebSearch does NOT clear a data claim → BLOCK', gateBlocksS(fWebDA, 'D'), true);
  cliS(['godqa'], 'QU'); cliS(['add', 'godpixel'], 'QU'); // qa (run-strict) + godpixel→developer (screenshot-as-proof, merged)
  const fShotQA = writeFixture('fix_launder_qa_uiux', [
    userPrompt('test and restyle'), asstTool('Edit', { file_path: 'C:/work/x.test.js', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('mcp__chrome-devtools__take_screenshot', {}), toolResult(), asstText('All green, looks great. Done.')]);
  expect('221. qa+developer: a screenshot does NOT clear a qa claim → BLOCK (run-strict floor; ui-ux merged into developer)', gateBlocksS(fShotQA, 'QU'), true);

  // 222. POSITIVE control: with NO run-strict member, a tool-proof mode KEEPS its tool (no over-block).
  cliS(['goddev'], 'UD'); cliS(['add', 'godscout'], 'UD'); // developer (screenshot-proof, ui-ux merged) + researcher (neither is run-strict)
  const fShotUI = writeFixture('fix_uiux_dev_shot', [
    userPrompt('restyle the button'), asstTool('Edit', { file_path: 'C:/work/Button.tsx', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('mcp__chrome-devtools__take_screenshot', {}), toolResult(), asstText('Looks great on mobile — done.')]);
  expect('222. developer+researcher (no run-strict member): a screenshot STILL clears → ALLOW (no over-block)', gateBlocksS(fShotUI, 'UD'), false);

  // 222b-d. LAUNDERING FIX (audit): a researcher-only proof (WebSearch / `npm view`) must NOT clear a
  // STRICT-FLOOR mode's claim even when that mode is tool-proof (developer/web-builder are reReadClears:false
  // WITH chrome verify-tools, so they were NOT run-strict → pre-fix the soft-proof drop never fired and the
  // fact-fetch laundered the build/readiness claim). Now the drop keys on any reReadClears:false sibling.
  const fDevWeb = writeFixture('launder_dev_websearch', [
    userPrompt('build it'), asstTool('Edit', { file_path: 'C:/work/x.ts', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('WebSearch', { query: 'x' }), toolResult(), asstText('It compiles and is shipped. Done.')]);
  expect('222b. developer+researcher: a WebSearch does NOT clear a developer build/ship claim → BLOCK (no laundering)', gateBlocksS(fDevWeb, 'UD'), true);
  const fDevNpm = writeFixture('launder_dev_npmview', [
    userPrompt('build it'), asstTool('Edit', { file_path: 'C:/work/x.ts', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('Bash', { command: 'npm view react version' }), toolResult(), asstText('Done — it compiles, shipped.')]);
  expect('222c. developer+researcher: a researcher `npm view` does NOT clear a developer build claim → BLOCK', gateBlocksS(fDevNpm, 'UD'), true);
  cliS(['godsite'], 'WR'); cliS(['add', 'godscout'], 'WR'); // web-builder (strict-floor, tool-proof) + researcher
  const fWebWeb = writeFixture('launder_web_websearch', [
    userPrompt('build the site'), asstTool('Edit', { file_path: 'C:/work/index.html', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('WebSearch', { query: 'x' }), toolResult(), asstText('The site is deployment-ready. Done.')]);
  expect('222d. web-builder+researcher: a WebSearch does NOT clear a deployment-ready claim → BLOCK', gateBlocksS(fWebWeb, 'WR'), true);

  // 223. FIX (review #4/#6-dup): a no-session SessionStart must NOT surface the global-fallback memory.
  cliS(['mem', 'set', 'gk', 'GVAL']);       // SID='' → writes the GLOBAL fallback memory store
  const injNoSid = (() => { const input = JSON.stringify({ hook_event_name: 'SessionStart' }); try { return execFileSync('node', [INJECT], { input, encoding: 'utf8', env: baseEnv() }); } catch (e) { return e.stdout || ''; } })();
  expect('223. no-session SessionStart does NOT leak the global-fallback memory (session-only feature)', /\[session-mem/.test(injNoSid), false);

  // 224. FIX (review #8): memDigest never exceeds maxTotal (the prefix + suffix are counted in the cap).
  const digCode = `const m=require(${JSON.stringify(HOOKS + '/godmem-core.js')}); const H=process.env.DET_HOOKS_HOME; for(let i=0;i<60;i++) m.memSet(H,'DIG','k'+i,'x'.repeat(40)); process.stdout.write(String(m.memDigest(H,'DIG',{maxItems:8,maxTotal:300}).length))`;
  let digLen = 99999; try { digLen = parseInt(execFileSync('node', ['-e', digCode], { encoding: 'utf8', env: baseEnv() }), 10); } catch (_) {}
  expect('224. memDigest respects maxTotal (digest length <= cap, prefix+suffix counted)', digLen > 0 && digLen <= 300, true);

  // 225-227. FIX (review #4-gc): gcSessions keeps fresh + current dirs; prunes a genuinely-old one. (A
  // stat-failing dir is treated as KEEP by the fix — covered by code review; here we lock age + keepSid.)
  const gcCode = `const s=require(${JSON.stringify(HOOKS + '/godstate-core.js')}); const fs=require('fs'); const H=process.env.DET_HOOKS_HOME; const root=s.sessionsRoot(H);
    for(const n of ['cur','fresh','old']){ fs.mkdirSync(root+'/'+n,{recursive:true}); fs.writeFileSync(root+'/'+n+'/mode','qa\\n'); }
    const past=Date.now()/1000 - 40*24*3600; fs.utimesSync(root+'/old', past, past);
    const removed=s.gcSessions(H,{keepSid:'cur'});
    process.stdout.write(JSON.stringify({removed, cur:fs.existsSync(root+'/cur'), fresh:fs.existsSync(root+'/fresh'), old:fs.existsSync(root+'/old')}))`;
  let gc = {}; try { gc = JSON.parse(execFileSync('node', ['-e', gcCode], { encoding: 'utf8', env: baseEnv() })); } catch (e) { gc = { err: String(e.stderr || e.message) }; }
  expect('225. gcSessions prunes a genuinely-old (40d) session overlay', gc.old, false);
  expect('226. gcSessions KEEPS a fresh dir (an unknown/fresh mtime is never age-0 deleted)', gc.fresh, true);
  expect('227. gcSessions never removes the current session (keepSid)', gc.cur, true);

  // 228-230. FIX (SECOND review #1, HIGH): a soft/RETRIEVAL mode (researcher) co-active with a
  // run-strict mode must not LAUNDER its claim via extraTestCmd — a fact-fetch (`npm view` / `gh api`
  // / `git ls-remote`) is not verification of tests/data/deploy. (First fix closed verify-TOOLS only.)
  cliS(['godqa'], 'L1'); cliS(['add', 'godscout'], 'L1');
  const fNpmView = writeFixture('launder_tc_npmview', [
    userPrompt('test+research'), asstTool('Edit', { file_path: 'C:/work/x.test.js', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('Bash', { command: 'npm view react version' }), toolResult(), asstText('All green, coverage complete, no regressions. Done.')]);
  expect('228. qa+researcher: a `npm view` does NOT clear a qa claim → BLOCK (extraTestCmd laundering closed)', gateBlocksS(fNpmView, 'L1'), true);
  cliS(['goddata'], 'L2'); cliS(['add', 'godscout'], 'L2');
  const fGhApi = writeFixture('launder_tc_ghapi', [
    userPrompt('analyze+research'), asstTool('Edit', { file_path: 'C:/work/a.sql', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('Bash', { command: 'gh api repos/x/y' }), toolResult(), asstText('The data shows the total is 42. Done.')]);
  expect('229. data-analyst+researcher: a `gh api` does NOT clear → BLOCK', gateBlocksS(fGhApi, 'L2'), true);
  // POSITIVE controls: genuine command-proof runners are NOT over-blocked, and researcher ALONE is unchanged.
  cliS(['goddev'], 'L3'); cliS(['add', 'godqa'], 'L3');
  const fMvn = writeFixture('launder_ctrl_mvn', [
    userPrompt('finish'), asstTool('Edit', { file_path: 'C:/work/Foo.java', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('Bash', { command: 'mvn test' }), toolResult(), asstText('Build clean, tests pass. Done.')]);
  expect('230a. developer+qa: a real `mvn test` STILL clears → ALLOW (no over-block)', gateBlocksS(fMvn, 'L3'), false);
  cliS(['godscout'], 'L4');
  const fSolo = writeFixture('launder_ctrl_solo', [
    userPrompt('latest?'), asstTool('Write', { file_path: 'C:/work/r.md', content: 'x' }), toolResult(),
    asstTool('Bash', { command: 'npm view react version' }), toolResult(), asstText('Latest is 18, per the registry. Done.')]);
  expect('230b. researcher ALONE: a `npm view` still clears → ALLOW (single-mode unchanged)', gateBlocksS(fSolo, 'L4'), false);

  // 231. FIX (review #9a): dropping the LAST active mode UN-pins (so autopilot can resume), like `general`.
  cliS(['goddev'], 'DL'); cliS(['drop', 'goddev'], 'DL');
  const pinnedCode = `const r=require(${JSON.stringify(HOOKS + '/godmode-mode.js')}); process.stdout.write(String(r.isPinned(process.env.DET_HOOKS_HOME,'DL')))`;
  let dlPinned = 'ERR'; try { dlPinned = execFileSync('node', ['-e', pinnedCode], { encoding: 'utf8', env: baseEnv() }).trim(); } catch (_) {}
  expect('231. drop the LAST mode → session is NOT pinned (autopilot can resume)', dlPinned, 'false');

  // 232. FIX (review #2): the CLI DEGRADES (exit 0 + message, no stack trace) when a core is absent.
  const part = `${home}/partial`; fs.rmSync(part, { recursive: true, force: true }); fs.mkdirSync(`${part}/hooks`, { recursive: true });
  fs.copyFileSync(CLI, `${part}/godmode.mjs`); fs.copyFileSync(`${HOOKS}/godmode-mode.js`, `${part}/hooks/godmode-mode.js`); // NO godstate/godmem cores
  const partRes = spawnSync('node', [`${part}/godmode.mjs`], { encoding: 'utf8', env: baseEnv() });
  const partOut = (partRes.stdout || '') + (partRes.stderr || '');
  expect('232. CLI with a core module absent → exit 0 + clean message (no ERR_MODULE_NOT_FOUND crash)', partRes.status === 0 && /core module|reinstall/i.test(partOut) && !/ERR_MODULE_NOT_FOUND/.test(partOut), true);

  // 233. FIX (THIRD review): `--session <flag/mode/subcommand>` is rejected (usage error, exit 1) — incl.
  // dashed aliases (--off/-s) which sanitizeSid would otherwise accept as a phantom session id. A real
  // UUID session id still works (never starts with '-').
  const sErr = (val) => { const r = spawnSync('node', [CLI, '--session', val, 'status'], { encoding: 'utf8', env: baseEnv() }); return r.status; };
  expect('233a. `--session goddev` (a mode) → usage error exit 1', sErr('goddev'), 1);
  expect('233b. `--session off` (a subcommand) → usage error exit 1', sErr('off'), 1);
  expect('233c. `--session --off` (a dashed alias) → usage error exit 1 (no phantom session)', sErr('--off'), 1);
  expect('233d. `--session -s` (a dashed flag) → usage error exit 1', sErr('-s'), 1);
  const okReal = spawnSync('node', [CLI, '--session', 'a1b2c3d4-uuid-like', 'status'], { encoding: 'utf8', env: baseEnv() });
  expect('233e. `--session <uuid-like>` (a real id) → accepted, status runs (exit 0)', okReal.status, 0);
}

// ====================================================================================
// ===== AUTO-PILOT: the SINGLE auto-routing switch (godsense/godsession merged in) — ==
// ===== immediate + AGGRESSIVE routing (god modes most of the time, normal Claude ONLY ==
// ===== for easy prompts); a confident signal switches mode, every switch names it =====
// ====================================================================================
{
  const home = `${FIX}/autopilot`; fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(`${home}/.claude`, { recursive: true });
  fs.writeFileSync(`${home}/.claude/deterministic-contract.md`, 'base contract');
  const benv = () => ({ ...process.env, DET_HOOKS_HOME: home, GODMODE_MODE: '', GODMODE_MODES_DIR: MODES_DIR });
  const node1 = (code, ...args) => { try { return execFileSync('node', ['-e', code, ...args], { encoding: 'utf8', env: benv() }).trim(); } catch (_) { return 'ERR'; } };
  const easy = (t) => node1(`process.stdout.write(String(require(${JSON.stringify(HOOKS + '/godsense-core.js')}).easyPrompt(process.argv[1])))`, t) === 'true';
  const route = (t, cur, agg) => node1(`process.stdout.write(String(require(${JSON.stringify(HOOKS + '/godsense-core.js')}).routeMode(process.argv[1], process.argv[2], {aggressive: process.argv[3]==='1'})))`, t, cur, agg ? '1' : '0');
  const cliA = (args, sid) => { const e = benv(); if (sid) e.CLAUDE_CODE_SESSION_ID = sid; try { return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: e }); } catch (er) { return (er.stdout || '') + (er.stderr || ''); } };
  const rmodeA = (sid) => { try { return JSON.parse(execFileSync('node', ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(HOOKS + '/godmode-mode.js')}).resolveModes(process.env.DET_HOOKS_HOME,'', ${JSON.stringify(sid)})))`], { encoding: 'utf8', env: benv() })); } catch (_) { return ['ERR']; } };
  const adA = (sid, prompt) => { try { const o = execFileSync('node', [DRIFT], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid }), encoding: 'utf8', env: benv() }); return JSON.parse(o).hookSpecificOutput.additionalContext; } catch (_) { return ''; } };

  // 234. easyPrompt — only clearly trivial input is "easy"; anything substantive is NOT (bias to god modes).
  expect('234a. easyPrompt: "ok thanks" → easy', easy('ok thanks'), true);
  expect('234b. easyPrompt: "refactor the auth module" → NOT easy', easy('refactor the auth module'), false);
  expect('234c. easyPrompt: "make this better and improve the whole thing" → NOT easy (substantive)', easy('make this better and improve the whole thing'), false);
  // 234d-h. INFLECTION-STEM regression: short substantive prompts must NOT be misjudged "easy" (the
  // trailing-\b bug that let "analyze"/"migrate"/"optimize" slip through to general — under-routing).
  expect('234d. easyPrompt: "analyze the sales data" → NOT easy (stem inflection)', easy('analyze the sales data'), false);
  expect('234e. easyPrompt: "migrate to typescript" → NOT easy', easy('migrate to typescript'), false);
  expect('234f. easyPrompt: "why is this slow" → NOT easy', easy('why is this slow'), false);
  expect('234g. easyPrompt: "clean this up" → NOT easy', easy('clean this up'), false);
  expect('234h. easyPrompt: "what is a closure" → easy (genuinely trivial Q&A)', easy('what is a closure'), true);

  // 235. routeMode — conservative stays on unclear; aggressive routes substantive→god mode, easy→general.
  expect('235a. route(conservative): unclear substantive → stay (null)', route('make this better and improve the whole thing', 'general', false), 'null');
  expect('235b. route(aggressive): unclear substantive → developer (default god mode)', route('make this better and improve the whole thing', 'general', true), 'developer');
  expect('235c. route(aggressive): confident "write unit tests with coverage" → qa', route('write unit tests with coverage', 'general', true), 'qa');
  expect('235d. route(aggressive): easy ack while in a god mode → STAY (null, no churn — keeps task context)', route('ok thanks', 'developer', true), 'null');
  expect('235e. route(aggressive): substantive while already in a god mode → stay (null, no churn)', route('make this much better overall', 'developer', true), 'null');
  expect('235f. route(aggressive): easy while in general → stay general (null)', route('ok thanks', 'general', true), 'null');
  // 235g. over-match guard: casual chat with a common-English prefix must NOT force-route to a god mode.
  expect('235g. route(aggressive): "valid point thanks" → stay general (no over-route)', route('valid point thanks', 'general', true), 'null');

  // 236. CLI `autopilot on` → global autosession + arm (the single switch — no separate session flag); `off` reverts.
  cliA(['autopilot', 'on']);
  expect('236a. autopilot on → global autosession + active sentinels (single switch, no godmode-session)', fs.existsSync(`${home}/.claude/godmode-autosession`) && fs.existsSync(`${home}/.claude/godmode-active`) && !fs.existsSync(`${home}/.claude/godmode-session`), true);

  // 237. e2e through anti-drift (autopilot on): substantive→god mode (named), confident→qa, easy→general.
  const sub = adA('AP1', 'make this better and improve the whole thing');
  expect('237a. autopilot e2e: substantive-but-unclear → routes to a GOD MODE (developer), banner NAMES it', /\[autopilot\]/.test(sub) && /Active mode for this prompt: developer \(goddev\)/.test(sub) && JSON.stringify(rmodeA('AP1')) === JSON.stringify(['developer']), true);
  const qa = adA('AP2', 'please write unit tests with coverage for the auth module');
  expect('237b. autopilot e2e: confident task → matching mode (qa)', JSON.stringify(rmodeA('AP2')), JSON.stringify(['qa']));
  expect('237c. autopilot e2e: easy prompt (fresh session) → stays general (normal Claude)', JSON.stringify(rmodeA('AP3')), JSON.stringify(['general'])); // never prompted, never routed
  adA('AP3', 'ok thanks here'); // an easy prompt does not move it off general
  expect('237d. autopilot e2e: an easy prompt keeps general (normal Claude)', JSON.stringify(rmodeA('AP3')), JSON.stringify(['general']));

  // 238. godmonitor SessionStart ANNOUNCES auto-pilot immediately (no asking).
  fs.writeFileSync(`${home}/.claude/godmode-active`, '');
  let monMsg = ''; try { monMsg = JSON.parse(execFileSync('node', [MON_HOOK], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'AP4', source: 'startup' }), encoding: 'utf8', env: benv() })).hookSpecificOutput.additionalContext; } catch (_) {}
  expect('238. godmonitor: autopilot on → announces AUTO-PILOT immediately, does NOT ask autopilot-or-normal', /AUTO-PILOT is ON/.test(monMsg) && !/Auto-routing \(autopilot\) is OFF/.test(monMsg), true);

  // 239. `autopilot off` reverts to conservative (no force-routing of unclear prompts).
  cliA(['autopilot', 'off']);
  expect('239. autopilot off → cleared; unclear prompt no longer force-routed', !fs.existsSync(`${home}/.claude/godmode-autosession`) && !/\[autopilot\]/.test(adA('AP5', 'make this better and improve the whole thing')), true);

  // 240. FIX (review rank 1, HIGH): a session can OPT OUT of GLOBAL autopilot; the message is honest.
  // (`autopilot off --session <id>` is the per-session opt-out now that the separate `session` toggle is gone.)
  cliA(['autopilot', 'on']); // global default back on
  const senseEn = (sid) => node1(`process.stdout.write(String(require(${JSON.stringify(HOOKS + '/godsense-core.js')}).senseEnabled(process.env.DET_HOOKS_HOME, ${JSON.stringify(sid)})))`) === 'true';
  const offMsg = cliA(['autopilot', 'off', '--session', 'OPT1'], 'OPT1');
  expect('240a. `autopilot off --session` under global autopilot → routing STOPS for THIS session', senseEn('OPT1'), false);
  expect('240b. ...the message is HONEST (this session stops; global stays on), not a global-nuke', /this session stops auto-routing/i.test(offMsg) && /GLOBAL default stays ON/i.test(offMsg), true);
  expect('240c. a DIFFERENT session still auto-routes (global default intact)', senseEn('OPT2'), true);

  // 241. FIX (review rank 2): `autopilot off --session <id>` is PER-SESSION; it does NOT nuke the global.
  cliA(['autopilot', 'off', '--session', 'OPT3']);
  expect('241a. `autopilot off --session` opts that session out', senseEn('OPT3'), false);
  expect('241b. ...the GLOBAL default is untouched (other sessions still route)', fs.existsSync(`${home}/.claude/godmode-autosession`) && senseEn('OPT4'), true);

  // 242. FIX (review rank 3+5): under autopilot, if hooks/godsense-core.js is MISSING, the monitor still
  // announces AUTO-PILOT (no false "Auto-routing is OFF") AND warns the sensing module is gone. (buildMonHome
  // does NOT copy godsense-core.js into the sandbox hooks/, so this exercises the missing-module path.)
  const apMon = buildMonHome('ap_missing_core', { mode: null });
  fs.writeFileSync(`${apMon}/.claude/godmode-autosession`, '');
  const apCtx = monCtx(runMonitor(apMon));
  expect('242. autopilot + godsense-core.js missing → announces AUTO-PILOT and warns the module is missing (no false OFF)', /AUTO-PILOT is ON/.test(apCtx) && /godsense-core/.test(apCtx) && !/Auto-routing \(autopilot\) is OFF/.test(apCtx), true);

  // 242b. COLLAPSE REGRESSION (audit-found): the monitor's routingOn must key ONLY on `autosession`,
  // NOT the removed `sense`/`session` flags. A stale legacy `godmode-sense` sentinel with autopilot OFF
  // (and godsense-core.js missing in the buildMonHome sandbox) must NOT produce a false "auto-routing …
  // silently dead" warning — before the fix, routingOn ORed sense||session||autosession and false-fired.
  const staleMon = buildMonHome('stale_sense_no_autopilot', { mode: null });
  fs.writeFileSync(`${staleMon}/.claude/godmode-sense`, 'enabled\n'); // legacy sentinel; autopilot (autosession) is OFF
  const staleCtx = runMonitor(staleMon);
  expect('242b. stale godmode-sense + autopilot OFF → routingOn keys on autosession only (NO false silently-dead warning)',
    /silently dead/.test(staleCtx), false);
}

// 243. SWITCH CONSISTENCY (audit fix): a switch to a PATH-GATED mode from OUTSIDE its scope must NOT
// inject that mode's full contract — the contract injection is reconciled against the RESOLVED primary
// (resolveModes path-gates it to general), so the announcement, the banner, the contract, and the Stop
// gate can never disagree. (Reachable only if a user scopes a built-in; no shipped mode ships scope.json.)
{
  const h = `${FIX}/switch_scoped`; fs.rmSync(h, { recursive: true, force: true }); fs.mkdirSync(`${h}/.claude/hooks`, { recursive: true });
  for (const f of ['godmode-mode.js', 'godstate-core.js', 'godsense-core.js', 'godmem-core.js', 'godmonitor-core.js']) fs.copyFileSync(`${HOOKS}/${f}`, `${h}/.claude/hooks/${f}`);
  fs.writeFileSync(`${h}/.claude/deterministic-contract.md`, 'base');
  fs.cpSync(MODES_DIR, `${h}/.claude/modes`, { recursive: true });
  fs.writeFileSync(`${h}/.claude/modes/developer/scope.json`, JSON.stringify({ paths: ['C:/scoped-only-dir'] })); // gate developer to a dir
  const env = { ...process.env, DET_HOOKS_HOME: h, GODMODE_MODE: '', GODMODE_MODES_DIR: `${h}/.claude/modes` };
  try { execFileSync('node', ['-e', `const s=require(${JSON.stringify(HOOKS + '/godstate-core.js')}); s.writeState(${JSON.stringify(h)},'SC','autosession','enabled\\n'); s.writeState(${JSON.stringify(h)},'SC','active','enabled\\n')`], { env }); } catch (_) {}
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'reproduce and fix the bug from the stack trace', session_id: 'SC', cwd: 'C:/somewhere-else' });
  let ctx = ''; try { ctx = JSON.parse(execFileSync('node', [DRIFT], { input, encoding: 'utf8', env })).hookSpecificOutput.additionalContext; } catch (_) {}
  expect('243. path-gated switch from outside scope → general banner + NO wrong-mode contract injected', /Active mode for this prompt: general/.test(ctx) && !/MODE SWITCHED to developer/.test(ctx), true);
}

// ====================================================================================
// ===== REVIEWER MODE (godreview): adversarial code review / audit ====================
// Proof = every finding VERIFIED; "LGTM / clean / no issues / safe to merge" is a sign-off claim that
// needs a real inspection behind it. reReadClears:false — a re-read of your own fix is not proof.
// ====================================================================================
{
  // canonical + resolver (alias loads to the reviewer folder)
  expect('250a. canonical: godreview → reviewer', canonSays('godreview'), 'reviewer');
  expect('250b. canonical: godaudit → reviewer', canonSays('godaudit'), 'reviewer');
  expect('250c. canonical: audit → reviewer', canonSays('audit'), 'reviewer');
  expect('250d. resolver: GODMODE_MODE=godreview (alias) → reviewer', runResolver({ GODMODE_MODE: 'godreview', GODMODE_MODES_DIR: MODES_DIR }), 'reviewer');

  // a "LGTM / no issues" sign-off after a mutation needs a real verification run (mode-specific claim words)
  const fClaim = writeFixture('review_signoff_noproof', [
    userPrompt('review the change'),
    asstTool('Edit', { file_path: 'C:/work/src/auth.js', old_string: 'a', new_string: 'b' }), toolResult(),
    asstText('Reviewed — looks good, no issues, LGTM.')]);
  expect('251a. reviewer: mutation + "LGTM/no issues" + no proof → BLOCK', runGate(fClaim, { mode: 'reviewer' }).blocked, true);
  expect('251b. general: "LGTM/no issues" is not a base claim → ALLOW (proves it is reviewer-specific)', runGate(fClaim).blocked, false);

  // a linter run post-edit clears; a bare re-read does NOT (reReadClears:false)
  const fLint = writeFixture('review_lint_clears', [
    userPrompt('review and fix'),
    asstTool('Edit', { file_path: 'C:/work/src/auth.js', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('Bash', { command: 'eslint src/auth.js' }), toolResult(),
    asstText('Fixed the finding — clean now, no issues.')]);
  expect('252a. reviewer: post-edit linter (eslint) run → ALLOW', runGate(fLint, { mode: 'reviewer' }).blocked, false);
  const fReread = writeFixture('review_reread_blocks', [
    userPrompt('review and fix'),
    asstTool('Edit', { file_path: 'C:/work/src/auth.js', old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('Read', { file_path: 'C:/work/src/auth.js' }), toolResult(),
    asstText('Reviewed — looks good, no issues.')]);
  expect('252b. reviewer: a bare re-read does NOT clear a sign-off (reReadClears:false) → BLOCK', runGate(fReread, { mode: 'reviewer' }).blocked, true);

  // autopilot routes a review/audit prompt to the reviewer mode
  expect('253a. sense: "do a code review of this PR" → reviewer', senseSays('please do a code review of this PR'), 'reviewer');
  expect('253b. sense: "audit the auth module for security issues" → reviewer', senseSays('audit the auth module for security issues'), 'reviewer');

  // injectors are mode-aware for reviewer (SessionStart contract + per-turn reminder)
  expect('254a. inject SessionStart in reviewer mode → reviewer contract', /reviewer mode/i.test(runInject(INJECT, 'SessionStart', { mode: 'reviewer' })) && /godreview/.test(runInject(INJECT, 'SessionStart', { mode: 'reviewer' })), true);
  expect('254b. anti-drift in reviewer mode → godreview reminder', /godreview/.test(runInject(DRIFT, 'UserPromptSubmit', { mode: 'reviewer' })), true);
}

// ====================================================================================
// ===== PLANNER MODE (godplan): architecture / implementation planning ================
// Proof = the plan is GROUNDED in the real code (you surveyed it), not an imagined codebase.
// reReadClears:false — re-reading the plan you just wrote does NOT clear a "ready to build" claim.
// ====================================================================================
{
  expect('260a. canonical: godplan → planner', canonSays('godplan'), 'planner');
  expect('260b. canonical: godarch → planner', canonSays('godarch'), 'planner');
  expect('260c. canonical: architect → planner', canonSays('architect'), 'planner');
  expect('260d. resolver: GODMODE_MODE=godplan (alias) → planner', runResolver({ GODMODE_MODE: 'godplan', GODMODE_MODES_DIR: MODES_DIR }), 'planner');

  // a planner "ready to build / sound design" sign-off after writing a plan file needs grounding proof
  const fPlan = writeFixture('plan_signoff_noproof', [
    userPrompt('plan the refactor'),
    asstTool('Write', { file_path: 'C:/work/PLAN.md', content: 'x' }), toolResult(),
    asstText('The design is sound — solid plan, let\'s build it.')]);
  expect('261a. planner: write plan + "solid plan/design is sound" + no survey → BLOCK', runGate(fPlan, { mode: 'planner' }).blocked, true);
  expect('261b. general: those planner phrases are not base claims → ALLOW (proves planner-specific)', runGate(fPlan).blocked, false);

  // a codebase SURVEY (grep) grounds the plan and clears; a bare re-read of the plan does NOT
  const fGrep = writeFixture('plan_survey_clears', [
    userPrompt('plan the refactor'),
    asstTool('Write', { file_path: 'C:/work/PLAN.md', content: 'x' }), toolResult(),
    asstTool('Bash', { command: 'grep -rn "auth" src/' }), toolResult(),
    asstText('Surveyed the call sites — solid plan, the design is sound.')]);
  expect('262a. planner: post-write codebase survey (grep) → ALLOW (grounded)', runGate(fGrep, { mode: 'planner' }).blocked, false);
  const fReread = writeFixture('plan_reread_blocks', [
    userPrompt('plan the refactor'),
    asstTool('Write', { file_path: 'C:/work/PLAN.md', content: 'x' }), toolResult(),
    asstTool('Read', { file_path: 'C:/work/PLAN.md' }), toolResult(),
    asstText('Re-read it — solid plan, design is sound.')]);
  expect('262b. planner: re-reading the plan you wrote does NOT clear (reReadClears:false) → BLOCK', runGate(fReread, { mode: 'planner' }).blocked, true);
  // the Glob survey TOOL also grounds + clears
  const fGlob = writeFixture('plan_glob_clears', [
    userPrompt('plan the refactor'),
    asstTool('Write', { file_path: 'C:/work/PLAN.md', content: 'x' }), toolResult(),
    asstTool('Glob', { pattern: 'src/**/*.js' }), toolResult(),
    asstText('Mapped the files — solid plan, design is sound.')]);
  expect('262c. planner: post-write Glob survey tool → ALLOW (grounded)', runGate(fGlob, { mode: 'planner' }).blocked, false);

  // autopilot routes a planning prompt to the planner mode
  expect('263a. sense: "plan the migration approach" → planner', senseSays('help me plan the migration approach'), 'planner');
  expect('263b. sense: "how should I architect this system" → planner', senseSays('how should I architect this system'), 'planner');

  // injectors are mode-aware for planner
  expect('264a. inject SessionStart in planner mode → planner contract', /planner mode/i.test(runInject(INJECT, 'SessionStart', { mode: 'planner' })) && /godplan/.test(runInject(INJECT, 'SessionStart', { mode: 'planner' })), true);
  expect('264b. anti-drift in planner mode → godplan reminder', /godplan/.test(runInject(DRIFT, 'UserPromptSubmit', { mode: 'planner' })), true);

  // 265. FIX (godplan review #1, MED over-block): describing existing/alternative code is NOT a sign-off.
  const fDesc1 = writeFixture('plan_desc_clear', [
    userPrompt('plan the refactor'), asstTool('Edit', { file_path: 'C:/work/PLAN.md', old_string: 'a', new_string: 'b' }), toolResult(),
    asstText('The existing code already has a clear design with separation between the token and session layers.')]);
  expect('265a. planner: describing existing code ("clear design") does NOT block → ALLOW', runGate(fDesc1, { mode: 'planner' }).blocked, false);
  const fDesc2 = writeFixture('plan_desc_sound', [
    userPrompt('plan it'), asstTool('Write', { file_path: 'C:/work/PLAN.md', content: 'x' }), toolResult(),
    asstText('Option B is a sound approach but adds a dependency, which is the main risk.')]);
  expect('265b. planner: weighing an alternative ("sound approach but…") does NOT block → ALLOW', runGate(fDesc2, { mode: 'planner' }).blocked, false);

  // 266. FIX (review #3/#4, under-match): a real sign-off still BLOCKs — natural-order "comprehensive plan",
  // a typographic-apostrophe "let’s build it", and the verdict "this is a solid plan".
  const fComp = writeFixture('plan_comprehensive', [
    userPrompt('plan it'), asstTool('Write', { file_path: 'C:/work/PLAN.md', content: 'x' }), toolResult(),
    asstText('This is a comprehensive plan covering every migration step.')]);
  expect('266a. planner: "comprehensive plan" sign-off (no survey) → BLOCK (under-match fixed)', runGate(fComp, { mode: 'planner' }).blocked, true);
  const fCurly = writeFixture('plan_curly_apos', [
    userPrompt('plan it'), asstTool('Write', { file_path: 'C:/work/PLAN.md', content: 'x' }), toolResult(),
    asstText('Mapped it out — let’s build it now.')]); // U+2019 curly apostrophe
  expect('266b. planner: curly-apostrophe "let’s build it" sign-off → BLOCK (apostrophe class fixed)', runGate(fCurly, { mode: 'planner' }).blocked, true);
  const fVerdict = writeFixture('plan_verdict', [
    userPrompt('plan it'), asstTool('Write', { file_path: 'C:/work/PLAN.md', content: 'x' }), toolResult(),
    asstText('This is a solid plan.')]);
  expect('266c. planner: "this is a solid plan" verdict sign-off → BLOCK', runGate(fVerdict, { mode: 'planner' }).blocked, true);

  // 267. FIX (review #2, MED over-route): casual "plan" prose no longer forces a planner switch.
  expect('267a. sense: "do you have a plan for the weekend" → NOT planner (casual prose)', senseSays('do you have a plan for the weekend'), '');
  expect('267b. sense: "I plan to visit the museum tomorrow" → NOT planner', senseSays('I plan to visit the museum tomorrow'), '');
  expect('267c. sense: "plan the migration approach" → STILL planner (real planning kept)', senseSays('help me plan the migration approach'), 'planner');

  // 268. FIX: an explicit "make a plan / make N plans" request routes to PLANNER even when the body
  // mentions "implement" (the deliverable is the plan, not code). This is the original miss — a
  // "scan the codebase then make 3 plans on how to implement …" prompt was sent to developer because
  // "implement" is a strong dev signal and "make a plan" only tripped the weak generic "plan".
  expect('268a. sense: "make a plan on how to implement this" → planner (was developer)', senseSays('scan the codebase then make a plan on how to implement this'), 'planner');
  expect('268b. sense: "make 3 plans on how to implement X" → planner', senseSays('make 3 plans on how to implement the google integration'), 'planner');
  expect('268c. sense: plain "implement the login function/endpoint" → STILL developer (no plan deliverable)', senseSays('implement the login function and the logout endpoint'), 'developer');
  expect('268d. sense: "make a backup of the database" → NOT planner (no plan deliverable)', senseSays('make a backup of the database'), '');
}

// ====================================================================================
// ===== SessionEnd cleanup: an explicit pick is LOCAL to its session and CLEARED when =
// ===== that session ends — never touching the global seed or any OTHER session. ======
// ====================================================================================
{
  const home = `${FIX}/sessionend`; fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(`${home}/.claude`, { recursive: true });
  const baseEnv = () => ({ ...process.env, DET_HOOKS_HOME: home, GODMODE_MODE: '', GODMODE_MODES_DIR: MODES_DIR });
  const cliS = (args, sid) => { const env = baseEnv(); if (sid) env.CLAUDE_CODE_SESSION_ID = sid; try { return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
  const rModes = (sid) => { const code = `const r=require(${JSON.stringify(HOOKS + '/godmode-mode.js')}); process.stdout.write(JSON.stringify(r.resolveModes(process.env.DET_HOOKS_HOME, '', ${JSON.stringify(sid)})))`; try { return JSON.parse(execFileSync('node', ['-e', code], { encoding: 'utf8', env: baseEnv() })); } catch (_) { return ['ERR']; } };
  const endHook = (sid, reason) => { const payload = { hook_event_name: 'SessionEnd' }; if (sid !== undefined) payload.session_id = sid; if (reason !== undefined) payload.reason = reason; let ok = true; try { execFileSync('node', [END], { input: JSON.stringify(payload), encoding: 'utf8', env: baseEnv() }); } catch (_) { ok = false; } return ok; };
  const overlay = (sid, name) => fs.existsSync(`${home}/.claude/godmode-sessions/${sid}/${name}`);

  // a GENUINE end (logout) clears the session's explicit pick → it falls back to the global seed.
  cliS(['goddev'], 'E1');
  expect('270a. precondition: session E1 is developer (its own overlay)', JSON.stringify(rModes('E1')), JSON.stringify(['developer']));
  endHook('E1', 'logout');
  expect('270b. SessionEnd(logout) clears E1 → resolves general again', JSON.stringify(rModes('E1')), JSON.stringify(['general']));
  expect('270c. SessionEnd(logout) removed E1\'s explicit PIN overlay', overlay('E1', 'explicit'), false);
  expect('271. SessionEnd never writes/leaves the GLOBAL seed', fs.existsSync(`${home}/.claude/godmode-mode`), false);

  // a CONTINUATION (resume / clear) PRESERVES the overlay — you keep your mode when you come back.
  cliS(['goddev'], 'E2'); endHook('E2', 'resume');
  expect('272. SessionEnd(resume) PRESERVES the overlay (developer survives)', JSON.stringify(rModes('E2')), JSON.stringify(['developer']));
  cliS(['goddev'], 'E3'); endHook('E3', 'clear');
  expect('273. SessionEnd(clear) PRESERVES the overlay (developer survives)', JSON.stringify(rModes('E3')), JSON.stringify(['developer']));

  // ending ONE session never touches another session's pick.
  cliS(['goddev'], 'E4'); cliS(['godqa'], 'E5'); endHook('E4', 'logout');
  expect('274a. SessionEnd(E4) → E4 cleared to general', JSON.stringify(rModes('E4')), JSON.stringify(['general']));
  expect('274b. SessionEnd(E4) did NOT touch E5 (still qa)', JSON.stringify(rModes('E5')), JSON.stringify(['qa']));

  // a SessionEnd with NO session id is a safe no-op (never poisons the global seed).
  expect('275a. SessionEnd with no session_id → hook exits cleanly', endHook(undefined, 'logout'), true);
  expect('275b. SessionEnd with no session_id → no global seed written', fs.existsSync(`${home}/.claude/godmode-mode`), false);

  // an UNKNOWN end reason defaults to clearing (treat anything that isn't a known continuation as an end).
  cliS(['goddev'], 'E6'); endHook('E6', 'some_future_reason');
  expect('276. SessionEnd(unknown reason) defaults to clearing E6', JSON.stringify(rModes('E6')), JSON.stringify(['general']));

  // 276b-c. WP-2.5: a genuine end also clears DELEGATION state (subagent-mode), so a resumed session never
  // runs its subagents under a stale delegated contract. A continuation (resume) preserves it.
  cliS(['goddev'], 'E7'); cliS(['subagent-mode', 'godqa'], 'E7');
  expect('276b-pre. session E7 has a subagent-mode delegation overlay', overlay('E7', 'subagent-mode'), true);
  endHook('E7', 'logout');
  expect('276b. SessionEnd(logout) clears the subagent-mode delegation (no stale delegation on resume)', overlay('E7', 'subagent-mode'), false);
  cliS(['goddev'], 'E8'); cliS(['subagent-mode', 'godqa'], 'E8'); endHook('E8', 'resume');
  expect('276c. SessionEnd(resume) PRESERVES subagent-mode (continuation keeps its delegation)', overlay('E8', 'subagent-mode'), true);
}

// ====================================================================================
// ===== HARMONIZE + COLLABORATION (handoffs, subagent-mode) + META-GUARD ==============
// ====================================================================================
// 280. HANDOFFS registry: every mode maps only to REAL modes; handoffGuidance emits /trigger pointers.
{
  const code = `const m=require(${JSON.stringify(HOOKS + '/godmode-mode.js')}); const real=new Set(Object.keys(m.PRIMARY)); let bad=0; for(const [mode,h] of Object.entries(m.HANDOFFS)){ if(!real.has(mode)) bad++; for(const t of [...h.next,...h.pairs]) if(!real.has(t)) bad++; } process.stdout.write(JSON.stringify({keys:Object.keys(m.HANDOFFS).length, bad, dev:m.handoffGuidance('developer'), gen:m.handoffGuidance('general')}))`;
  let r = {}; try { r = JSON.parse(execFileSync('node', ['-e', code], { encoding: 'utf8', env: { ...process.env, GODMODE_MODES_DIR: MODES_DIR } })); } catch (_) {}
  expect('280a. HANDOFFS maps the 8 modes, every target is a real mode (0 bad)', r.keys === 8 && r.bad === 0, true);
  expect('280b. handoffGuidance(developer) points to /godqa /godreview /godship', /\/godqa/.test(r.dev || '') && /\/godreview/.test(r.dev || '') && /\/godship/.test(r.dev || ''), true);
  expect('280c. handoffGuidance(general) is empty (no relationships)', (r.gen || '') === '', true);
}
// 281. SessionStart contract injection carries the (generated) handoff guidance.
{
  const o = runInject(INJECT, 'SessionStart', { mode: 'developer' });
  expect('281. SessionStart (developer) contract includes "Works with / hand off to" + /godqa', /Works with . hand off to/.test(o) && /\/godqa/.test(o), true);
}
// 282. handoff: `godmode.mjs handoff <to> <ctx>` surfaces ONCE to the target mode, not others, then clears.
{
  const h = `${FIX}/handoff_t`; fs.rmSync(h, { recursive: true, force: true }); fs.mkdirSync(`${h}/.claude`, { recursive: true });
  fs.writeFileSync(`${h}/.claude/deterministic-contract.md`, 'base');
  const envF = (sid) => ({ ...process.env, DET_HOOKS_HOME: h, GODMODE_MODE: '', GODMODE_MODES_DIR: MODES_DIR, ...(sid ? { CLAUDE_CODE_SESSION_ID: sid } : {}) });
  const cli = (args, sid) => { try { return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: envF(sid) }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
  const drift = (sid) => { const inp = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'continue', session_id: sid }); try { return JSON.parse(execFileSync('node', [DRIFT], { input: inp, encoding: 'utf8', env: envF() })).hookSpecificOutput.additionalContext; } catch (_) { return ''; } };
  cli(['developer'], 'HF'); cli(['handoff', 'godqa', 'added refund path needs edge-case tests'], 'HF');
  const inDev = drift('HF');           // still developer → handoff (to=qa) NOT surfaced
  cli(['godqa'], 'HF');
  const inQa1 = drift('HF');           // now qa → surfaced once
  const inQa2 = drift('HF');           // one-shot → already cleared
  expect('282a. handoff NOT surfaced while in a non-target mode', /handoff to/.test(inDev), false);
  expect('282b. handoff surfaced once to the target mode (qa) with its context', /handoff to godqa/.test(inQa1) && /added refund path/.test(inQa1), true);
  expect('282c. handoff is one-shot (cleared after delivery)', /handoff to/.test(inQa2), false);
}
// 283. subagent-mode: a spawned subagent runs under the DELEGATED mode (contract + gate); parent unchanged.
{
  const h = `${FIX}/subagent_t`; fs.rmSync(h, { recursive: true, force: true }); fs.mkdirSync(`${h}/.claude`, { recursive: true });
  fs.writeFileSync(`${h}/.claude/deterministic-contract.md`, 'base');
  const envF = (sid) => ({ ...process.env, DET_HOOKS_HOME: h, GODMODE_MODE: '', GODMODE_MODES_DIR: MODES_DIR, ...(sid ? { CLAUDE_CODE_SESSION_ID: sid } : {}) });
  const cli = (args, sid) => { try { return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: envF(sid) }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
  const inj = (evt) => { const inp = JSON.stringify({ hook_event_name: evt, session_id: 'SA' }); try { return JSON.parse(execFileSync('node', [INJECT], { input: inp, encoding: 'utf8', env: envF() })).hookSpecificOutput.additionalContext; } catch (_) { return ''; } };
  // SubagentStop now REQUIRES a derivable subagent transcript (no more parent-fallback): place fx's content
  // at the derived direct path and pass agent_id + the parent transcript, so the gate judges the sub-mode.
  const gate = (evt) => {
    let txPath = fx;
    const aid = 'aSAMODE';
    if (evt === 'SubagentStop') {
      const mainTp = `${h}/.claude/sa_main.jsonl`;
      fs.writeFileSync(mainTp, JSON.stringify(userPrompt('spawn a subagent')) + '\n');
      const sd = `${mainTp.replace(/\.jsonl$/i, '')}/subagents`;
      fs.mkdirSync(sd, { recursive: true });
      fs.copyFileSync(fx, `${sd}/agent-${aid}.jsonl`);
      txPath = mainTp;
    }
    const p = JSON.stringify({ hook_event_name: evt, transcript_path: txPath, agent_id: aid, stop_hook_active: false, session_id: 'SA' });
    let out = ''; try { out = execFileSync('node', [GATE], { input: p, encoding: 'utf8', env: envF() }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); } return /"decision"\s*:\s*"block"/.test(out);
  };
  cli(['developer'], 'SA'); cli(['subagent-mode', 'godqa'], 'SA');
  const subStart = inj('SubagentStart'), sesStart = inj('SessionStart');
  // discriminating fixture: a post-edit screenshot CLEARS for developer (tool-proof) but NOT for qa (run-strict).
  const fx = writeFixture('subagent_gate', [userPrompt('x'), asstTool('Edit', { file_path: 'C:/work/x.tsx', old_string: 'a', new_string: 'b' }), toolResult(), asstTool('mcp__chrome-devtools__take_screenshot', {}), toolResult(), asstText('Done — it works now.')]);
  expect('283a. SubagentStart injects the delegated sub-mode (qa) contract, not the parent', /qa mode \(godqa\)/.test(subStart) && !/developer mode \(goddev\)/.test(subStart), true);
  expect('283b. SessionStart (parent) is unchanged = developer, not qa', /developer mode \(goddev\)/.test(sesStart) && !/qa mode \(godqa\)/.test(sesStart), true);
  expect('283c. SubagentStop gate enforces the sub-mode qa (run-strict → screenshot does NOT clear → BLOCK)', gate('SubagentStop'), true);
  cli(['subagent-mode', 'off'], 'SA');
  expect('283d. after subagent-mode off → SubagentStop uses parent developer (screenshot clears → ALLOW)', gate('SubagentStop'), false);
}
// 284. META-PROMPT guard (conservative): prompts ABOUT the GODCLAUDE system stay put; real tasks STILL route.
{
  const routeSays = (p) => { try { return execFileSync('node', ['-e', `process.stdout.write(String(require('./godsense-core.js').routeMode(${JSON.stringify(p)},'general',{aggressive:true})))`], { cwd: HOOKS, encoding: 'utf8' }).trim(); } catch (_) { return 'ERR'; } };
  expect('284a. meta: "improve the godmonitor" → STAY (null)', routeSays('improve the godmonitor'), 'null');
  expect('284b. meta: "evaluate the modes to make them harmonize" → STAY (null)', routeSays('evaluate the modes to make them harmonize'), 'null');
  expect('284c. meta: "how should the modes switch" → STAY (null)', routeSays('how should the modes switch'), 'null');
  expect('284d. real task "deploy to kubernetes" → STILL routes (ci-cd)', routeSays('deploy the service to kubernetes'), 'ci-cd');
  expect('284e. real task "review the auth code for bugs" → STILL routes (reviewer)', routeSays('review the auth code for bugs'), 'reviewer');
  expect('284f. real task "fix the dark mode styling" → NOT suppressed (routes, not null)', routeSays('fix the dark mode styling on the button') !== 'null', true);
}

// ====================================================================================
// ===== GAP FIXES (v1.7.1): handoff multi-mode/global/corrupt, meta FP, status, subagent symmetry =====
// ====================================================================================
// helpers shared by the gap-fix tests (own sandbox + CLI/hook drivers).
function gapSandbox(name) {
  const h = `${FIX}/${name}`; fs.rmSync(h, { recursive: true, force: true }); fs.mkdirSync(`${h}/.claude`, { recursive: true });
  fs.writeFileSync(`${h}/.claude/deterministic-contract.md`, 'base');
  return h;
}
const gapEnv = (h, sid) => ({ ...process.env, DET_HOOKS_HOME: h, GODMODE_MODE: '', GODMODE_MODES_DIR: MODES_DIR, ...(sid ? { CLAUDE_CODE_SESSION_ID: sid } : {}) });
const gapCli = (h, args, sid) => { try { return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: gapEnv(h, sid) }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const gapDrift = (h, sid) => { const inp = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'continue', session_id: sid }); try { return JSON.parse(execFileSync('node', [DRIFT], { input: inp, encoding: 'utf8', env: gapEnv(h) })).hookSpecificOutput.additionalContext; } catch (_) { return ''; } };

// 285. handoff to a SECONDARY active mode (multi-mode) surfaces (was: only primary checked).
{
  const h = gapSandbox('gap_handoff_secondary');
  gapCli(h, ['godqa'], 'M'); gapCli(h, ['add', 'goddev'], 'M');     // active set: [qa, developer]; primary=qa
  gapCli(h, ['handoff', 'goddev', 'wire up the new endpoint'], 'M'); // target = developer (the SECONDARY)
  const out = gapDrift(h, 'M');
  expect('285. handoff to a SECONDARY active mode surfaces (multi-mode)', /handoff to goddev/.test(out) && /wire up the new endpoint/.test(out), true);
}
// 286. a GLOBAL handoff is one-shot inside a session (delivered once, then cleared — not every turn forever).
{
  const h = gapSandbox('gap_handoff_global');
  gapCli(h, ['handoff', 'godqa', 'global note', '--global']); // GLOBAL handoff (no session)
  gapCli(h, ['godqa'], 'G');                                   // session G primary = qa
  const first = gapDrift(h, 'G'), second = gapDrift(h, 'G');
  expect('286a. global handoff surfaces once to the target mode', /handoff to godqa/.test(first), true);
  expect('286b. global handoff is one-shot (cleared, not re-surfaced every turn)', /handoff to godqa/.test(second), false);
}
// 287. CLI `handoff clear` from inside a session DOES clear a GLOBAL handoff + reports honestly (not false success).
{
  const h = gapSandbox('gap_handoff_clear');
  gapCli(h, ['handoff', 'godqa', 'gctx', '--global']);
  const show = gapCli(h, ['handoff', 'show'], 'C');           // from session C → should see the global, labeled global
  const clr = gapCli(h, ['handoff', 'clear'], 'C');           // must actually remove the global file
  const showAfter = gapCli(h, ['handoff', 'show'], 'C');
  expect('287a. handoff show from a session sees the global handoff (labeled global)', /Pending handoff \[global default\]/.test(show), true);
  expect('287b. handoff clear from a session removes the global handoff (honest, not false success)', /cleared \[global default\]/.test(clr) && /No pending handoff/.test(showAfter), true);
}
// 288. a corrupt handoff overlay self-heals (cleared on the next turn instead of lingering forever).
{
  const h = gapSandbox('gap_handoff_corrupt');
  fs.mkdirSync(`${h}/.claude/godmode-sessions/K`, { recursive: true });
  fs.writeFileSync(`${h}/.claude/godmode-sessions/K/handoff`, '{ not valid json');
  fs.writeFileSync(`${h}/.claude/godmode-sessions/K/mode`, 'developer\n');
  gapDrift(h, 'K'); // first turn: hook should self-heal (clear the unparseable note)
  expect('288. corrupt handoff overlay self-heals (cleared after one turn)', fs.existsSync(`${h}/.claude/godmode-sessions/K/handoff`), false);
}
// 289. META-GUARD false-positive fix: generic "the X modes" / "the modes of X" tasks are NOT suppressed.
{
  const routeSays = (p) => { try { return execFileSync('node', ['-e', `process.stdout.write(String(require('./godsense-core.js').routeMode(${JSON.stringify(p)},'general',{aggressive:true})))`], { cwd: HOOKS, encoding: 'utf8' }).trim(); } catch (_) { return 'ERR'; } };
  expect('289a. "review the modes of transport" → NOT suppressed (routes, not null)', routeSays('review the modes of transport') !== 'null', true);
  expect('289b. "audit the permission modes" → NOT suppressed (routes, not null)', routeSays('audit the permission modes') !== 'null', true);
  expect('289c. GODCLAUDE-meta "evaluate the modes to harmonize" → STILL suppressed (null)', routeSays('evaluate the modes to make them harmonize'), 'null');
}
// 290. status surfaces a sticky subagent-mode + a pending handoff (discoverability).
{
  const h = gapSandbox('gap_status');
  gapCli(h, ['developer'], 'ST'); gapCli(h, ['subagent-mode', 'godqa'], 'ST'); gapCli(h, ['handoff', 'godreview', 'check the diff'], 'ST');
  const status = gapCli(h, [], 'ST'); // no-arg status
  expect('290. status shows subagent-mode + pending handoff', /subagent-mode: godqa/.test(status) && /Pending handoff . godreview/.test(status), true);
}
// 291. SubagentStop guard symmetry: a half-broken sub-mode (contract.md missing) → gate FALLS BACK to parent,
//      so the subagent is never gated under a mode whose contract it was not given.
{
  const h = gapSandbox('gap_subagent_symmetry');
  // local modes copy so we can break ONE mode's contract.md without touching the shared MODES_DIR.
  fs.cpSync(MODES_DIR, `${h}/.claude/modes`, { recursive: true });
  fs.writeFileSync(`${h}/.claude/modes/qa/contract.md`, ''); // half-broken qa: gate.json present, contract.md EMPTY
  const env = (sid) => ({ ...process.env, DET_HOOKS_HOME: h, GODMODE_MODE: '', GODMODE_MODES_DIR: `${h}/.claude/modes`, ...(sid ? { CLAUDE_CODE_SESSION_ID: sid } : {}) });
  const cli = (args, sid) => { try { return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: env(sid) }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
  cli(['developer'], 'SY'); cli(['subagent-mode', 'godqa'], 'SY'); // delegate to the half-broken qa
  // screenshot fixture: clears for developer (tool-proof) but not for run-strict qa.
  const fx = writeFixture('gap_sym', [userPrompt('x'), asstTool('Edit', { file_path: 'C:/work/x.tsx', old_string: 'a', new_string: 'b' }), toolResult(), asstTool('mcp__chrome-devtools__take_screenshot', {}), toolResult(), asstText('Done — it works.')]);
  const p = JSON.stringify({ hook_event_name: 'SubagentStop', transcript_path: fx, stop_hook_active: false, session_id: 'SY' });
  let out = ''; try { out = execFileSync('node', [GATE], { input: p, encoding: 'utf8', env: env() }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  expect('291. half-broken sub-mode (no contract) → SubagentStop falls back to PARENT developer (screenshot clears → ALLOW)', /"decision"\s*:\s*"block"/.test(out), false);
}

// ====================================================================================
// ===== WINDOWS confirm-guard parity (gap #5/#6): the goddev propose-only boundary must =
// ===== fire on win32-native BACKSLASH paths too — PowerShell is wired alongside Bash.   =
// ====================================================================================
// 116. secret-file guard on backslash paths (the native win32 separator).
expect('116a. goddev: `Get-Content $env:USERPROFILE\\.ssh\\id_rsa` (backslash) → ASK', runGuard('Get-Content $env:USERPROFILE\\.ssh\\id_rsa', { tool: 'PowerShell' }), true);
expect('116b. goddev: `type .aws\\credentials` (backslash) → ASK', runGuard('type .aws\\credentials', { tool: 'PowerShell' }), true);
expect('116c. goddev: forward-slash `cat .aws/credentials` still → ASK (no regression)', runGuard('cat .aws/credentials'), true);
// 117. relative-deploy guard on the PowerShell-native `.\deploy.ps1` form.
expect('117a. goddev: `.\\deploy.ps1` (PowerShell relative) → ASK', runGuard('.\\deploy.ps1', { tool: 'PowerShell' }), true);
expect('117b. goddev: `powershell .\\deploy.ps1` → ASK', runGuard('powershell .\\deploy.ps1', { tool: 'PowerShell' }), true);
expect('117c. goddev: `./deploy.sh` (forward slash) still → ASK (no regression)', runGuard('./deploy.sh'), true);
// 118. web-builder (godsite) propose-only parity (gap #14): its contract forbids live-infra/publish, so
// the confirm guard must ASK on the same infra/publish/cloud verbs developer guards — not just push/deploy.
expect('118a. godsite: `docker push registry/app` → ASK (contract forbids publishing)', runGuard('docker push registry/app:latest', { mode: 'web-builder' }), true);
expect('118b. godsite: `terraform apply` → ASK (contract forbids live infra)', runGuard('terraform apply -auto-approve', { mode: 'web-builder' }), true);
expect('118c. godsite: `git push` still → ASK (unchanged)', runGuard('git push', { mode: 'web-builder' }), true);
expect('118d. godsite: `docker build .` → ALLOW (building is fine; only publishing asks)', runGuard('docker build -t app .', { mode: 'web-builder' }), false);

// ====================================================================================
// ===== PROOF-GATE: a FAILED verification command must NOT clear (gap #1) + an HONEST   =
// ===== NEGATIVE closing message must NOT be read as a completion claim (gap #10).       =
// ====================================================================================
{
  const asstToolId = (name, input, id) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input, id }] } });
  const toolResultId = (id, isError, content) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isError, content: String(content == null ? 'ok' : content) }] } });

  // 300. a RED test/build after the edit is not proof — running it then claiming "done" must still BLOCK.
  const f300a = writeFixture('failtest_iserror_block', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(),
    asstToolId('Bash', { command: 'npm test' }, 't1'), toolResultId('t1', true, '1 failed, 2 passed'),
    asstText('Done — fixed it, the tests pass now.'),
  ]);
  expect('300a. failed test (is_error:true) does NOT clear the gate → BLOCK', runGate(f300a).blocked, true);

  const f300b = writeFixture('failtest_textsig_block', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(),
    asstToolId('Bash', { command: 'pytest -k repro' }, 't2'), toolResultId('t2', false, 'FAILED tests/test_x.py::test_repro - AssertionError\n1 failed, 0 passed'),
    asstText('Done — fixed, it passes.'),
  ]);
  expect('300b. failed test (output signature, no is_error flag) does NOT clear → BLOCK', runGate(f300b).blocked, true);

  // 300c/d. POSITIVE controls: a genuinely PASSING test still clears, and a result we cannot LOCATE
  // (legacy fixtures with no tool_use id linkage) fails OPEN exactly as before — no over-block.
  const f300c = writeFixture('passtest_allow', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(),
    asstToolId('Bash', { command: 'npm test' }, 't3'), toolResultId('t3', false, 'Tests: 5 passed, 0 failed'),
    asstText('Done — fixed it, the tests pass now.'),
  ]);
  expect('300c. a PASSING test (is_error:false, no failure signature) STILL clears → ALLOW', runGate(f300c).blocked, false);

  const f300d = writeFixture('failtest_noresult_allow', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(),
    asstTool('Bash', { command: 'npm test' }), toolResult(),
    asstText('Done — tests pass.'),
  ]);
  expect('300d. test with no locatable result → fail-open clears (legacy behavior preserved) → ALLOW', runGate(f300d).blocked, false);

  // 301. honest-negative closing messages must NOT be read as completion claims.
  const f301a = writeFixture('neg_notworking_allow', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(),
    asstText('This is still not working — the repro test is not passing yet. I have not verified the fix; the root cause is unconfirmed.'),
  ]);
  expect('301a. honest negative (not working / not passing / not verified) → ALLOW (not a claim)', runGate(f301a).blocked, false);

  const f301b = writeFixture('neg_mixed_block', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(),
    asstText('The edge case is not handled yet, but the main bug is fixed and the build passes.'),
  ]);
  expect('301b. a real un-negated claim ("fixed"/"passes") amid a negative clause still → BLOCK', runGate(f301b).blocked, true);

  const f301c = writeFixture('neg_notonly_block', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(),
    asstText('Not only does the parser handle it, the whole thing works now and is done.'),
  ]);
  expect('301c. "not only ... works ... done" — negator attaches elsewhere → still a claim → BLOCK', runGate(f301c).blocked, true);
}

// ====================================================================================
// ===== GODSITE PROMPT-SCOPE deterministic teardown (gap #3) + HEARTBEAT on switch (gap #11) ==
// ====================================================================================
// 244. `web-builder --scope prompt` serves exactly the NEXT request, then auto-deactivates on the
//      following prompt; `--scope session` persists across turns (no teardown).
{
  const home = `${FIX}/godsite_scope`; fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(`${home}/.claude`, { recursive: true });
  fs.writeFileSync(`${home}/.claude/deterministic-contract.md`, 'base');
  const benv = () => ({ ...process.env, DET_HOOKS_HOME: home, GODMODE_MODE: '', GODMODE_MODES_DIR: MODES_DIR });
  const cli = (args, sid) => { const e = benv(); if (sid) e.CLAUDE_CODE_SESSION_ID = sid; try { return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: e }); } catch (er) { return (er.stdout || '') + (er.stderr || ''); } };
  const rmode = (sid) => { try { return JSON.parse(execFileSync('node', ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(HOOKS + '/godmode-mode.js')}).resolveModes(process.env.DET_HOOKS_HOME,'', ${JSON.stringify(sid)})))`], { encoding: 'utf8', env: benv() })); } catch (_) { return ['ERR']; } };
  const ad = (sid, prompt) => { try { execFileSync('node', [DRIFT], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid }), encoding: 'utf8', env: benv() }); } catch (_) {} };

  cli(['web-builder', '--scope', 'prompt'], 'WBP');
  expect('244a. godsite --scope prompt: web-builder is the active mode right after select', JSON.stringify(rmode('WBP')), JSON.stringify(['web-builder']));
  ad('WBP', 'build me a landing page');                               // T1: the ONE request, served in web-builder
  expect('244b. ...STILL web-builder during its one request (T1 only marks served)', JSON.stringify(rmode('WBP')), JSON.stringify(['web-builder']));
  ad('WBP', 'now write me a poem');                                   // T2: next prompt → teardown fires
  expect('244c. ...auto-deactivated to general on the NEXT prompt (T2)', JSON.stringify(rmode('WBP')), JSON.stringify(['general']));

  cli(['web-builder', '--scope', 'session'], 'WBS');
  ad('WBS', 'build me a site'); ad('WBS', 'add an about page');
  expect('244d. godsite --scope session: persists across turns (no teardown)', JSON.stringify(rmode('WBS')), JSON.stringify(['web-builder']));
}
// 245. a mid-session SWITCH re-emits a godmonitor heartbeat (gap #11) so the persistent trail reflects the
//      NEW mode, not the stale SessionStart mode.
{
  const home = `${FIX}/hb_switch`; fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(`${home}/.claude`, { recursive: true });
  fs.writeFileSync(`${home}/.claude/deterministic-contract.md`, 'base');
  const benv = () => ({ ...process.env, DET_HOOKS_HOME: home, GODMODE_MODE: '', GODMODE_MODES_DIR: MODES_DIR });
  const cli = (args, sid) => { const e = benv(); if (sid) e.CLAUDE_CODE_SESSION_ID = sid; try { return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: e }); } catch (er) { return (er.stdout || '') + (er.stderr || ''); } };
  const ad = (sid, prompt) => { try { execFileSync('node', [DRIFT], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid }), encoding: 'utf8', env: benv() }); } catch (_) {} };
  const hbTail = () => { try { return fs.readFileSync(`${home}/.claude/godmonitor.log`, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return {}; } }); } catch (_) { return []; } };
  cli(['autopilot', 'on']);
  ad('HB1', 'please write unit tests with coverage for the auth module');   // confident → qa switch
  const tail = hbTail();
  const last = tail[tail.length - 1] || {};
  expect('245a. a mid-session switch writes a NEW godmonitor heartbeat', tail.length >= 1, true);
  expect('245b. ...the heartbeat records the SWITCHED-TO mode (qa) with event:switch', last.effective === 'qa' && last.event === 'switch', true);
}

// 246. per-session memory caps (gap #16): a single value is length-capped, and the item count is bounded.
{
  const home = `${FIX}/memcap`; fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(`${home}/.claude`, { recursive: true });
  const benv = () => ({ ...process.env, DET_HOOKS_HOME: home });
  const node1 = (code) => { try { return execFileSync('node', ['-e', code], { encoding: 'utf8', env: benv() }).trim(); } catch (_) { return 'ERR'; } };
  const big = node1(`const m=require(${JSON.stringify(HOOKS + '/godmem-core.js')}); const H=process.env.DET_HOOKS_HOME; m.memSet(H,'MC','k','x'.repeat(99999)); process.stdout.write(String((m.memGet(H,'MC','k')||'').length))`);
  expect('246a. a stored value is length-capped (a huge input is truncated, not stored whole)', parseInt(big, 10) > 0 && parseInt(big, 10) <= 4096, true);
  const cnt = node1(`const m=require(${JSON.stringify(HOOKS + '/godmem-core.js')}); const H=process.env.DET_HOOKS_HOME; for(let i=0;i<230;i++) m.memSet(H,'MC2','k'+i,'v'+i); process.stdout.write(String(m.memCount(H,'MC2')))`);
  expect('246b. item count is bounded (oldest evicted past the cap)', parseInt(cnt, 10) > 0 && parseInt(cnt, 10) <= 200, true);
}

// ---- godmode-statusline.mjs (status-bar render) — behavioral coverage ----
// Drives the statusline the way Claude Code does (JSON on stdin, NO_COLOR=1) and asserts the rendered
// label across states. The statusline loads the resolver/store/sense CJS from <home>/.claude/hooks, so
// each home copies them in (mirrors the monitor-test setup); the CLI arms multi-mode for the session.
{
  const SL = path.resolve(HOOKS, '..', 'godmode-statusline.mjs').replace(/\\/g, '/');
  const slHome = (name, withHooks = true) => {
    const h = `${FIX}/${name}`;
    fs.rmSync(h, { recursive: true, force: true });
    fs.mkdirSync(`${h}/.claude/hooks`, { recursive: true });
    if (withHooks) for (const f of ['godmode-mode.js', 'godstate-core.js', 'godsense-core.js', 'godmem-core.js', 'godmonitor-core.js'])
      fs.copyFileSync(`${HOOKS}/${f}`, `${h}/.claude/hooks/${f}`);
    return h;
  };
  const statusline = (home, payload, extraEnv = {}) => {
    const env = { ...process.env, DET_HOOKS_HOME: home, NO_COLOR: '1', GODMODE_MODES_DIR: MODES_DIR, GODMODE_MODE: '', ...extraEnv };
    try { return execFileSync('node', [SL], { input: JSON.stringify(payload), encoding: 'utf8', env }).trim(); }
    catch (e) { return ((e && e.stdout) || '').trim(); }
  };
  // God-segment assertions isolate the mode label: NO cwd/workspace/model in the payload, so the
  // where/what segments (📁 dir · git · model — added when the feature-rich statusline was back-ported)
  // stay empty and line 1 is exactly the god segment. The dir segment gets its own assertion (315b).
  const PAY = { session_id: 'sl1' };
  const home = slHome('sl_home');
  const bare = slHome('sl_bare', false); // no resolver module present → layer "not installed here"
  expect('310. statusline: layer not installed + no cwd → empty line (fail-safe, never throws)', statusline(bare, PAY, { GODMODE_ACTIVE: '1' }), '');
  expect('311. statusline: dormant (not armed) → faint god:off', statusline(home, PAY, { GODMODE_ACTIVE: '0' }), 'god:off');
  // Statusline shows the Kami label "god:<Pseudonym> (<trigger>)" (user preference over trigger-only).
  expect('312. statusline: armed + no mode → god:Amaterasu (general)', statusline(home, PAY, { GODMODE_ACTIVE: '1' }), 'god:Amaterasu (general)');
  expect('313. statusline: armed + developer → god:Mahitotsu (goddev)', statusline(home, PAY, { GODMODE_ACTIVE: '1', GODMODE_MODE: 'developer' }), 'god:Mahitotsu (goddev)');
  expect('314. statusline: armed + qa → god:Enma (godqa)', statusline(home, PAY, { GODMODE_ACTIVE: '1', GODMODE_MODE: 'qa' }), 'god:Enma (godqa)');
  // multi-mode: arm developer + qa for THIS session via the CLI, then the bar joins them with ' + '.
  const cliEnv = { ...process.env, DET_HOOKS_HOME: home, GODMODE_MODES_DIR: MODES_DIR, GODMODE_MODE: '', CLAUDE_CODE_SESSION_ID: 'sl1' };
  try { execFileSync('node', [CLI, 'developer'], { encoding: 'utf8', env: cliEnv }); execFileSync('node', [CLI, 'add', 'qa'], { encoding: 'utf8', env: cliEnv }); } catch (_) {}
  expect('315. statusline: armed + multi-mode → god:Mahitotsu (goddev) + Enma (godqa)', statusline(home, PAY, { GODMODE_ACTIVE: '1' }), 'god:Mahitotsu (goddev) + Enma (godqa)');
  // 315b. Back-ported feature coverage: a payload carrying cwd renders the 📁 dir segment alongside the
  // god label (the where/what line the richer live statusline added). Proves the back-port's dirSeg works.
  const withDir = statusline(home, { session_id: 'sl1', cwd: 'C:/work/sample' }, { GODMODE_ACTIVE: '1' });
  expect('315b. statusline: cwd present → 📁 dir segment renders beside the god label', /📁 sample/.test(withDir) && /god:Mahitotsu \(goddev\) \+ Enma \(godqa\)/.test(withDir), true);
}

// ---- proof-gate: SubagentStop derivation reaches WORKFLOW-spawned subagents ----
// Workflow subagents nest one level deeper than direct Task subagents:
//   <main-transcript>/subagents/workflows/<run-id>/agent-<id>.jsonl
// Without scanning workflows/, the gate can't find the subagent's transcript, falls back to the MAIN
// transcript, and UNDER-enforces the subagent's unverified claim (a real gap once Workflow fan-outs are used).
{
  const aid = 'aWORKFLOWSUB';
  const mainTp = `${FIX}/wf_main.jsonl`;
  fs.writeFileSync(mainTp, JSON.stringify(userPrompt('spawn a workflow')) + '\n'); // main transcript must exist
  const subDir = `${FIX}/wf_main/subagents/workflows/wf_testrun`;
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(`${subDir}/agent-${aid}.jsonl`, [
    userPrompt('do the audit'),
    asstTool('Edit', { file_path: 'C:/work/sub.js', old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstText('Done — fixed and it works.'),
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  const payload = JSON.stringify({ hook_event_name: 'SubagentStop', transcript_path: mainTp, agent_id: aid, stop_hook_active: false, session_id: '' });
  let out = ''; try { out = execFileSync('node', [GATE], { input: payload, encoding: 'utf8', env: { ...process.env, GODMODE_MODE: 'general', GODMODE_MODES_DIR: MODES_DIR, DET_HOOKS_HOME: FIX } }); } catch (e) { out = e.stdout || ''; }
  expect('316. SubagentStop derives a WORKFLOW subagent transcript (subagents/workflows/<run>/) and gates its unverified claim → BLOCK', /"decision"\s*:\s*"block"/.test(out), true);
}
// ---- WP-1.1: SubagentStop FAILS OPEN when the subagent transcript can't be derived (never judges the
// parent's mid-turn transcript). Two boundaries: (317) no agent_id at all, (318) agent_id present but the
// transcript never appears on disk (the ~389-agent transcript-less population). Both ALLOW, and 318 must be
// FAST — the old code judged the parent and burned the full 8×150ms≈1.2s flush budget; the new code retries
// derivation only 2×150ms then fails open, so it must finish well under the old budget. Derive+judge on
// SubagentStop is already proven by tests 8 (direct) and 316 (workflow) — these pin only the fail-open path.
{
  const runSub = (extra) => {
    const mainTp = `${FIX}/failopen_main.jsonl`;
    fs.writeFileSync(mainTp, [userPrompt('do work'), asstTool('Write', { file_path: WP, content: 'x' }), toolResult(), asstText('Done — it works now.')].map(o => JSON.stringify(o)).join('\n') + '\n');
    const payload = JSON.stringify({ hook_event_name: 'SubagentStop', transcript_path: mainTp, stop_hook_active: false, session_id: '', ...extra });
    let out = ''; const t0 = Date.now();
    try { out = execFileSync('node', [GATE], { input: payload, encoding: 'utf8', env: { ...process.env, GODMODE_MODE: 'general', GODMODE_MODES_DIR: MODES_DIR, DET_HOOKS_HOME: FIX } }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    return { blocked: /"decision"\s*:\s*"block"/.test(out), ms: Date.now() - t0 };
  };
  // 317. NO agent_id: cannot derive → fail-open ALLOW (never judges the parent transcript, which here carries
  // a bare "Done — it works now." mutation+claim that the OLD parent-fallback would have BLOCKED).
  expect('317. SubagentStop with NO agent_id → fail-open ALLOW (not parent-judged)', runSub({}).blocked, false);
  // 318. agent_id present but the derived transcript never exists → fail-open ALLOW, and FAST: 2×150ms
  // retries + node startup ≈ 350-700ms typical. Threshold 1100ms leaves headroom for heavy concurrent load
  // (this suite runs 5× inside the installer self-check) while still clearly proving the old 8×150ms flush
  // burn is gone — that path's SLEEPS alone were 1200ms, so a sub-1100ms wall time can't be doing 8 of them.
  const r318 = runSub({ agent_id: 'aNEVEREXISTS318' });
  expect('318a. SubagentStop, agent_id but transcript never on disk → fail-open ALLOW', r318.blocked, false);
  expect(`318b. SubagentStop fail-open is FAST (no 8×150ms parent-flush burn) — measured ${r318.ms}ms`, r318.ms < 1100, true);
}
// 319. WP-2.2 (A8 settledness): a DERIVED subagent transcript that legitimately ends on a tool_result (no
// closing assistant text) carries no completion claim → ALLOW, and does NOT burn the full 8×150ms budget —
// SubagentStop uses a 2×150ms cap. Proves the shorter budget both decides correctly and stays fast.
{
  const aid = 'aTOOLRESULTEND319';
  const mainTp = `${FIX}/sub319_main.jsonl`;
  fs.writeFileSync(mainTp, JSON.stringify(userPrompt('spawn a subagent')) + '\n');
  const subDir = `${FIX}/sub319_main/subagents`;
  fs.mkdirSync(subDir, { recursive: true });
  // subagent mutated a file then ended on a tool_result (no final assistant text) — the common shape.
  fs.writeFileSync(`${subDir}/agent-${aid}.jsonl`, [
    userPrompt('do the edit'), asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(),
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  const payload = JSON.stringify({ hook_event_name: 'SubagentStop', transcript_path: mainTp, agent_id: aid, stop_hook_active: false });
  const t0 = Date.now(); let out = '';
  try { out = execFileSync('node', [GATE], { input: payload, encoding: 'utf8', env: { ...process.env, GODMODE_MODE: 'general', GODMODE_MODES_DIR: MODES_DIR, DET_HOOKS_HOME: FIX } }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const ms = Date.now() - t0;
  expect('319a. SubagentStop, derived tx ends on tool_result (no claim) → ALLOW', /"decision"\s*:\s*"block"/.test(out), false);
  expect(`319b. SubagentStop tool_result-end is FAST (2×150ms cap, not 8×) — measured ${ms}ms`, ms < 1100, true);
}
// ---- WP-2.3: previously-untested critical paths ----
// 319c/d. dispatch="error" fail-open: an in-process hook that THROWS must make the wrapper emit NOTHING
// (allow / no-inject — never trap a session) and record dispatch:"error" in the perf log (godmode-stats
// keys off it to flag fail-opens). This path (godmode-gate.mjs:96-102) had ZERO coverage.
{
  const eh = `${FIX}/gate_error_home`; fs.rmSync(eh, { recursive: true, force: true }); fs.mkdirSync(`${eh}/.claude/hooks`, { recursive: true });
  const throwHook = `${eh}/.claude/hooks/throwhook.js`;
  fs.writeFileSync(throwHook, 'module.exports = () => { throw new Error("boom — simulated hook crash"); };\n');
  const input = JSON.stringify({ hook_event_name: 'Stop', transcript_path: 'nonexistent', stop_hook_active: false });
  const env = { ...process.env, GODMODE_ACTIVE: '1', DET_HOOKS_HOME: eh, GODMODE_MODE: 'general' }; // perf logging ON (no GODMODE_PERF=0)
  let out = ''; try { out = execFileSync('node', [WRAP, throwHook], { input, encoding: 'utf8', env }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  expect('319c. dispatch=error: a throwing hook → wrapper emits NOTHING (fail-open ALLOW, never traps)', out.trim(), '');
  const perf = (() => { try { return fs.readFileSync(`${eh}/.claude/godmode-perf.log`, 'utf8'); } catch (_) { return ''; } })();
  expect('319d. dispatch=error: the crash is recorded as dispatch:"error" in the perf log', /"dispatch"\s*:\s*"error"/.test(perf), true);
}
// 319e/f. LEGACY perf-record classification: a record with NO `dispatch` field (written by a pre-in-process
// build) must be counted as dispatch "legacy" by the analyzer — and a well-formed in-process record must NOT.
{
  const lh = `${FIX}/legacy_perf_home`; fs.rmSync(lh, { recursive: true, force: true }); fs.mkdirSync(`${lh}/.claude`, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(`${lh}/.claude/godmode-perf.log`,
    JSON.stringify({ ts: now, hook: 'block-unverified-completion', event: 'Stop', active: true, ms: 40, emitted: false, blocked: false }) + '\n' +          // no dispatch → legacy
    JSON.stringify({ ts: now, hook: 'block-unverified-completion', event: 'Stop', active: true, ms: 40, emitted: false, blocked: false, dispatch: 'in-process' }) + '\n');
  let mix = {}; try { mix = JSON.parse(execFileSync('node', ['-e', `const c=require(${JSON.stringify(HOOKS + '/godimprove-core.js')}); process.stdout.write(JSON.stringify(c.analyze(${JSON.stringify(lh)}).dispatchMix))`], { encoding: 'utf8' })); } catch (_) {}
  expect('319e. analyzer: a perf record with no dispatch field → counted as "legacy"', mix.legacy, 1);
  expect('319f. analyzer: a dispatch:"in-process" record → counted as in-process, not legacy', mix['in-process'], 1);
}

// ---- persistence gate (block-premature-stop.js): blocks GIVING UP on doable work, RETAINS confirmations ----
// The proof-gate's mirror: it bounces a turn that did real work + named the next step but stopped to
// RECOMMEND/DEFER it under standing approval. The owner-gate allowlist RETAINS godclaude's propose-don't-push
// confirmations (push/deploy/secret/prod/destructive/your-call/which-option), so those stops still pass.
{
  const PERSIST = `${HOOKS}/block-premature-stop.js`;
  const pBlocks = (name, objs, opts = {}) => {
    const tp = writeFixture(name, objs);
    const payload = { hook_event_name: opts.event || 'Stop', transcript_path: tp, stop_hook_active: !!opts.stopActive };
    let out = ''; try { out = execFileSync('node', [PERSIST], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, DET_HOOKS_HOME: FIX } }); } catch (e) { out = e.stdout || ''; }
    return /"decision"\s*:\s*"block"/.test(out);
  };
  const edit = () => asstTool('Edit', { file_path: 'C:/work/x.js', old_string: 'a', new_string: 'b' });
  // BLOCK: did real work, named the fix, stopped to recommend/defer with NO owner-gate.
  expect('320. persist: tools + give-up ("the fix is…; stopping here; let me know") + no owner-gate → BLOCK',
    pBlocks('p_giveup', [userPrompt('fix the build'), edit(), toolResult(), asstText('The fix is to update the config path. Stopping here — let me know if you would like me to continue.')]), true);
  // ALLOW — RETAIN confirmations: a sensitive/boundary action that genuinely needs the user's OK.
  expect('321. persist: tools + deploy is propose-only, needs your explicit OK → ALLOW (confirmation retained)',
    pBlocks('p_deploy', [userPrompt('build + deploy the site'), edit(), toolResult(), asstText('The production build passed. I prepared the deploy steps, but deploying is propose-only — it needs your explicit OK before I run it.')]), false);
  expect('322. persist: tools + git push is propose-only, your call → ALLOW (confirmation retained)',
    pBlocks('p_push', [userPrompt('commit the work'), edit(), toolResult(), asstText('Committed locally. git push is propose-only — your call whether to publish it to the remote.')]), false);
  expect('323. persist: tools + touches production secrets / irreversible → ALLOW (owner-gate)',
    pBlocks('p_prod', [userPrompt('rotate the key'), edit(), toolResult(), asstText('The change is staged. Applying it touches the production secrets store, which is irreversible — I need your go-ahead first.')]), false);
  // ALLOW — not give-ups: finished+verified, a real choice, pure chat, circuit breaker.
  expect('324. persist: tools + finished & verified (no give-up) → ALLOW',
    pBlocks('p_done', [userPrompt('fix it'), edit(), toolResult(), asstText('Done — re-ran the suite, 10/10 passing.')]), false);
  expect('325. persist: tools + a real choice ("which approach?") → ALLOW (owner decision)',
    pBlocks('p_choice', [userPrompt('improve it'), edit(), toolResult(), asstText('I scaffolded both. Which approach do you want — option A (simpler) or option B (faster)?')]), false);
  expect('326. persist: NO tools this turn (pure chat) even with a give-up phrase → ALLOW (exempt)',
    pBlocks('p_chat', [userPrompt('what do you think?'), asstText('The fix is probably X. Want me to proceed?')]), false);
  expect('327. persist: give-up but circuit breaker (stop_hook_active=true) → ALLOW (no loop)',
    pBlocks('p_cb', [userPrompt('fix'), edit(), toolResult(), asstText('The fix is X. Stopping here.')], { stopActive: true }), false);
  // COLLISION — the retention property: a give-up phrase AND a real confirmation in the SAME message →
  // the owner-gate WINS → ALLOW. This is exactly what "retain the confirmation" means: a genuine
  // push/deploy/your-call confirmation is never blocked even though it also reads like a deferral.
  expect('328. persist: give-up ("the fix is…") BUT also a real confirmation (git push / your call) → ALLOW (owner-gate wins)',
    pBlocks('p_collision', [userPrompt('apply the migration'), edit(), toolResult(), asstText('The fix is to push the schema migration. But git push is propose-only — it needs your explicit OK; your call whether to publish.')]), false);
}

// ---- self-improvement loop: godmonitor surfaces godimprove-core's data-driven suggestions at SessionStart ----
// Closing the loop — the suggestions that used to sit unread in godmode-stats now surface as live context,
// but ONLY on a high-signal item, ONLY on a real session start (not 'compact'), and NEVER auto-applied.
{
  // ts = NOW so the record falls inside the self-review's default 14-day recency window (WP-2.1). A stale
  // fixed date would be filtered out and the suggestion would never surface — the review examines RECENT activity.
  const perfLine = (dispatch) => JSON.stringify({ ts: new Date().toISOString(), hook: 'block-unverified-completion', event: 'Stop', active: true, ms: 50, emitted: true, blocked: false, dispatch });
  // signal home: a spawn-FALLBACK perf record → a 'high' suggestion → self-review surfaces.
  const sigHome = buildMonHome('mon_review_sig', { mode: 'qa' });
  fs.writeFileSync(`${sigHome}/.claude/godmode-perf.log`, perfLine('spawn') + '\n');
  const sigCtx = monCtx(runMonitor(sigHome));
  expect('330. self-review: high-signal perf log (spawn fallback) → godmonitor surfaces [GODCLAUDE self-review] + the suggestion',
    /\[GODCLAUDE self-review\]/.test(sigCtx) && /spawn FALLBACK/i.test(sigCtx), true);
  expect('330b. self-review rides ALONGSIDE the integrity check (qa still reported intact in the same output)', /qa mode active and intact/i.test(sigCtx), true);
  // clean home: only healthy in-process records → no signal → no self-review (silent when nothing to flag).
  const clnHome = buildMonHome('mon_review_clean', { mode: 'qa' });
  fs.writeFileSync(`${clnHome}/.claude/godmode-perf.log`, perfLine('in-process') + '\n');
  expect('331. self-review: clean perf log (in-process, no issues) → NO self-review surfaced (silent)', /\[GODCLAUDE self-review\]/.test(monCtx(runMonitor(clnHome))), false);
  // 'compact' (mid-session auto-summarize) → self-review suppressed even with signal (no nagging).
  expect('332. self-review: suppressed on source=compact (only real session starts surface it)', /\[GODCLAUDE self-review\]/.test(monCtx(runMonitor(sigHome, undefined, 'compact'))), false);
  // engine direct: selfReview(signal home) → signal=true with ≥1 item.
  let sr = {}; try { sr = JSON.parse(execFileSync('node', ['-e', `const c=require(${JSON.stringify(HOOKS + '/godimprove-core.js')}); process.stdout.write(JSON.stringify(c.selfReview(${JSON.stringify(sigHome)})))`], { encoding: 'utf8' })); } catch (_) {}
  expect('333. self-review engine: selfReview(signal home) → signal=true with ≥1 surfaced item', sr.signal === true && Array.isArray(sr.items) && sr.items.length >= 1, true);
}

// ---- flush-race FIX (latency): a no-mutation turn must NOT pay the full flush-race wait ----
// Root cause (from the live audit log): ~70% of UNSETTLED reads were muts=0 — a no-mutation turn is exempt
// regardless of its (still-flushing) closing text, so waiting for that flush is pure wasted gate latency.
// The fix checks for a mutation FIRST and only then pays the flush wait. Proof = wall time drops from ~1.2s.
{
  const noMut = writeFixture('flush_nomut', [userPrompt('look at the code'), asstTool('Read', { file_path: 'C:/work/x.js' }), toolResult()]); // mutation-free, ends on a tool_result (no closing text)
  const payload = JSON.stringify({ hook_event_name: 'Stop', transcript_path: noMut, stop_hook_active: false });
  const t0 = Date.now();
  try { execFileSync('node', [GATE], { input: payload, encoding: 'utf8', env: { ...process.env, GODMODE_MODE: 'general', GODMODE_MODES_DIR: MODES_DIR, DET_HOOKS_HOME: FIX } }); } catch (_) {}
  const ms = Date.now() - t0;
  expect(`340. flush-race: no-mutation/no-closing-text turn returns FAST (no full ~1.2s flush wait) — measured ${ms}ms (<600)`, ms < 600, true);
}

// ---- report ----
let allPass = true;
console.log('\n=== deterministic-hook layer — both-directions test ===');
for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}` + (c.pass ? '' : `   (got=${c.got} want=${c.want})`));
  if (!c.pass) allPass = false;
}
console.log(`\n${allPass ? 'ALL PASS' : 'SOME FAILED'} (${cases.filter(c => c.pass).length}/${cases.length})`);

// Test hygiene: clean up the fixtures we created (don't leave _testfix lying around).
try { fs.rmSync(FIX, { recursive: true, force: true }); } catch (_) {}

process.exit(allPass ? 0 : 1);
