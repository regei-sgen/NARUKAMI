#!/usr/bin/env node
'use strict';
// godsense-core.js — the auto-router for the GODCLAUDE mode system.
// "Senses what you need and switches to the matching mode." OPT-IN (off by default).
//
// IMPORTANT — what this is and isn't: this is a deterministic WEIGHTED SIGNAL scorer over the prompt
// text, NOT semantic understanding. It routes confidently-signalled tasks (e.g. "write unit tests" ->
// qa, "deploy to kubernetes" -> ci-cd) and DELIBERATELY does nothing on weak/ambiguous prompts (it
// keeps whatever mode you're already in). It is transparent (the anti-drift hook announces every
// switch) and correctable (an explicit /goddev or `godmode:` keyword wins; `autopilot off` disables it).
//
// Scoring: each signal carries a weight (2 = strong/distinctive, 1 = weak/supporting). A switch
// happens only when the top mode's score >= THRESHOLD AND beats the runner-up by >= MARGIN. A single
// STRONG signal triggers; a single WEAK signal does not; two modes tied on strong signals => no switch.

const fs = require('node:fs');
const R = require('./godmode-mode.js'); // homeDir
let STATE; try { STATE = require('./godstate-core.js'); } catch (_) { STATE = null; } // per-session flag overlay

const SIGNALS = {
  // developer ABSORBED debugger (godbug) + ui-ux (godpixel): their signals are folded in here so a
  // debug/UI-shaped prompt routes to the merged developer mode (there is no longer a debugger/ui-ux mode).
  developer: [
    [2, /\brefactor(ing|ed)?\b/i], [2, /\bimplement\b/i], [2, /\bendpoint\b/i],
    [1, /\b(add|write|build|create)\b[^.\n]{0,40}\b(function|class|api|feature|module|method)\b/i], [1, /\bfeature\b/i],
    // — merged from debugger —
    [2, /\bdebug(ging|ger)?\b/i], [2, /\bbug\b/i], [2, /\b(stack\s*trace|traceback)\b/i],
    [2, /\brepro(duce|duction)?\b/i], [2, /\broot\s+cause\b/i],
    [1, /\bcrash(es|ing)?\b/i], [1, /\bexception\b/i], [1, /\bthrows?\b/i], [1, /\b(error|errors)\b/i], [1, /\bwhy\b[^.\n]{0,40}\bfail/i],
    // — merged from ui-ux —
    [2, /\bscreenshot\b/i], [2, /\bresponsive\b/i], [2, /\b(css|tailwind|scss|sass)\b/i], [2, /\blayout\b/i],
    [1, /\bbutton\b/i], [1, /\bcomponent\b/i], [1, /\bstyling\b/i], [1, /\bspacing\b/i], [1, /\bcolou?r\b/i], [1, /\b(design|mockup)\b/i], [1, /\b(ui|ux)\b/i],
  ],
  researcher: [
    [2, /\bresearch\b/i], [2, /\blatest\s+(version|release)\b/i], [2, /\blook\s+up\b/i],
    [1, /\bcompare\b[^.\n]{0,40}\boptions\b/i], [1, /\b(docs|documentation|changelog)\b/i], [1, /\bbest\s+practices?\b/i],
  ],
  'data-analyst': [
    [2, /\bdataframe\b/i], [2, /\bdataset\b/i], [2, /\bpandas\b/i], [2, /\bsql\b/i],
    [2, /\bselect\b[^.\n]{0,40}\bfrom\b/i], [2, /\bgroup\s+by\b/i],
    [1, /\bquery\b/i], [1, /\bcsv\b/i], [1, /\baverage\b/i], [1, /\bmedian\b/i], [1, /\baggregate\b/i], [1, /\bhow\s+many\s+rows?\b/i],
  ],
  qa: [
    [2, /\bunit\s+tests?\b/i], [2, /\bcoverage\b/i], [2, /\bregression\b/i],
    [1, /\btests?\b/i], [1, /\bassert(ion)?s?\b/i],
  ],
  reviewer: [
    [2, /\bcode\s*review\b/i],
    [2, /\breview\s+(this|the|my|these|that|again|the\s+code)\b/i],
    [2, /\baudit\s+(the|this|my|for|code|security|it)\b/i],
    [2, /\blgtm\b/i],
    [1, /\breview\b/i], [1, /\baudit\b/i], [1, /\bsign[- ]?off\b/i], [1, /\bpull\s*request\b/i],
    [1, /\b(find|look\s+for|spot|catch|check\s+for)\b[^.\n]{0,40}\b(gaps?|issues?|problems?|smells?|anti[- ]?patterns?|vulnerab|regressions?)\b/i],
  ],
  planner: [
    // distinctive planning OBJECTS only — generic stop-words (the/it/out/this) would make everyday
    // "plan for the weekend" prose score a strong match and force a wrong switch under plain godsense.
    [2, /\b(plan|planning)\b[^.\n]{0,30}\b(approach|implementation|feature|migration|refactor|rollout|rewrite|architecture|system|schema|rearchitect|the\s+work|the\s+build|the\s+rollout|the\s+migration|the\s+refactor)\b/i],
    [2, /\barchitect(ure|ural)?\b/i],
    [2, /\bdesign\s+(doc|document|the\s+(system|architecture|approach|api|schema|data\s+model|flow))\b/i],
    [2, /\b(implementation|technical|design|migration)\s+plan\b/i],
    [2, /\bhow\s+(should|would|do)\s+(i|we|you)\s+(approach|structure|architect|design)\b/i],
    // an explicit request to PRODUCE a plan (a plan as the deliverable): "make a plan", "make 3 plans",
    // "draft a plan", "give me a plan". A producing-verb + a/N plan(s) — distinct from casual "I plan to
    // visit" / "a plan for the weekend" (no producing verb), which stay below threshold on the weak hit.
    [2, /\b(make|create|draft|write|give|produce|outline|propose|prepare|draw\s+up)\b[^.\n]{0,15}\bplans?\b/i],
    [1, /\bplans?\b/i], [1, /\broadmap\b/i], [1, /\bblueprint\b/i], [1, /\btrade[- ]?offs?\b/i], [1, /\bbreak\s+(this|it)\s+down\b/i], [1, /\bstrategy\b/i], [1, /\bproposal\b/i],
  ],
  'ci-cd': [
    [2, /\bdeploy(ment|ed|ing|s)?\b/i], [2, /\bpipeline\b/i], [2, /\b(kubernetes|k8s|terraform|helm)\b/i],
    [2, /\b(github\s+actions|gitlab\s+ci)\b/i], [1, /\b(docker|rollout|release)\b/i], [1, /\bci\/?cd\b/i],
  ],
};
const THRESHOLD = 2; // top mode's weighted score must reach this
const MARGIN = 1;    // and beat the runner-up by at least this (else ambiguous => no switch)

// Returns { mode, score, margin, hits[] } when confident, else null (weak/ambiguous => keep current mode).
function senseMode(prompt) {
  const text = String(prompt || '');
  if (!text.trim()) return null;
  const scores = {}, hits = {};
  for (const [mode, sigs] of Object.entries(SIGNALS)) {
    let s = 0; const h = [];
    for (const [w, re] of sigs) {
      const mm = text.match(re);
      if (mm) { s += w; const hit = mm[0].trim(); h.push(hit.length > 24 ? (hit.slice(0, 24).replace(/\s+\S*$/, '') || hit.slice(0, 24)) : hit); }
    }
    if (s > 0) { scores[mode] = s; hits[mode] = h; }
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [topMode, topScore] = ranked[0];
  const runnerUp = ranked[1] ? ranked[1][1] : 0;
  if (topScore < THRESHOLD || (topScore - runnerUp) < MARGIN) return null; // not confident => no switch
  return { mode: topMode, score: topScore, margin: topScore - runnerUp, hits: hits[topMode] };
}
// ---- AGGRESSIVE AUTO-PILOT (opt-in via `autopilot on`) -----------------------------------------
// Policy when auto-pilot is on: use a GOD MODE for most prompts; use normal Claude (general) ONLY for
// genuinely EASY prompts. This is biased toward god modes on purpose — easyPrompt returns true only for
// clearly trivial input, so anything substantive (even without a specific mode signal) routes to a mode.
const DEFAULT_MODE = 'developer'; // the general-purpose "do work" mode for substantive-but-unsignalled prompts

// A prompt is SUBSTANTIVE when it names real work. Split into two sets on purpose:
//  - WORK_STEM: distinctive PREFIX stems with a LEADING boundary but NO trailing one, so inflected
//    forms match (analy => analyze/analyzing/analysis; migrat => migrate/migrated; optimi => optimize).
//    A global \b(...)\b wrapper would force a boundary right after the stem and FAIL on "analyze" (the
//    'e' is not a boundary) — that was a real bug that under-routed substantive prompts to general.
//  - WORK_WORD: short/ambiguous words that need BOTH boundaries so they don't over-match (add vs
//    address, api vs apiece, slow vs slowly-is-fine).
// Broad by design: the user wants god modes MOST of the time, so we accept some over-routing.
// Stems that are ALSO common-English prefixes (comput→computer, pars→parsley, valid→valid point,
// scrap→scrap that) require completion to a WORK form so casual chat doesn't force-route to a god mode.
const WORK_STEM = /\b(refactor|implement|deploy|releas|analy|optimi|migrat|comput(e|es|ed|ing|ation)|aggregat|scrap(e|es|er|ed|ing)|crawl|automat|generat|configur|integrat|troubleshoot|diagnos|vulnerab|regress|pars(e|es|er|ed|ing)|render|debug|benchmark|profil|instrument|rewrit|restructur|reorganiz|simplif|modulariz|clean|improv|enhanc|investigat|orchestrat|scaffold|provision|valid(ate|ation|ity|ated|ating)|architect)/i;
const WORK_WORD = /\b(fix|fixes|fixed|fixing|build|built|builds|building|test|tests|testing|tested|create|creates|created|add|adds|added|adding|write|writes|writing|written|wrote|update|updates|updating|updated|upgrade|install|uninstall|setup|set\s?up|ship|design|review|audit|plan|planning|roadmap|blueprint|query|queries|script|endpoint|api|apis|function|functions|class|classes|method|methods|module|modules|component|components|database|schema|sql|pipeline|workflow|ci|cd|css|html|layout|style|styles|styling|screenshot|repro|traceback|exception|crash|crashes|crashing|bug|bugs|feature|features|architecture|performance|perf|security|coverage|lint|typecheck|compile|error|errors|broken|fail|fails|failing|failed|slow|hook|hooks|repo|repos|commit|commits|branch|rebase|merge|dockerfile|kubernetes|k8s|terraform|helm|server|client|frontend|backend|responsive|migrate|optimize|deploy)\b/i;
// Code-ish content (a fence, a filename, a call) also marks substantive.
const CODEY = /```|\b[\w./-]+\.(js|ts|tsx|jsx|mjs|cjs|py|go|rs|java|rb|php|cpp?|cs|sql|sh|ya?ml|json|md|html|css|scss)\b|\b\w+\([^)]*\)/;
function substantivePrompt(text) { const t = String(text || ''); return WORK_STEM.test(t) || WORK_WORD.test(t) || CODEY.test(t); }
// A whole-prompt greeting / acknowledgement / meta filler — clearly NOT a task.
const GREETING = /^(hi+|hello+|hey+|yo|sup|thanks?|thank\s?you|thx|ty|ok(ay)?|kk|cool|nice|great|awesome|perfect|yes|yep|yeah|no|nope|nah|sure|right|correct|exactly|indeed|got\s?it|makes\s?sense|continue|carry\s?on|go\s?ahead|go\s?on|please\s?continue|next|done|nvm|never\s?mind|hm+|lol|haha|cheers)\b[\s!.?,)]*$/i;

// Is the prompt EASY (=> normal Claude is fine)? True ONLY for clearly trivial input: empty, a pure
// greeting/ack, or a very short prompt with no work signal. Everything else is SUBSTANTIVE (=> god mode).
function easyPrompt(text) {
  const t = String(text || '').trim();
  if (!t) return true;                                   // nothing to do
  if (substantivePrompt(t)) return false;                // any work/code signal => NOT easy
  if (GREETING.test(t)) return true;                     // pure greeting/ack => easy
  return t.split(/\s+/).filter(Boolean).length <= 4;     // only VERY short chatty prompts are easy
}

// META-PROMPT detection (conservative): true when the prompt is ABOUT the GODCLAUDE system / its modes
// themselves rather than a task to perform. Requires BOTH an inspection/meta verb AND a GODCLAUDE-SYSTEM
// object — kept tight on purpose so ordinary tasks that merely contain "review/plan/the … mode" are NOT
// flagged (e.g. "review the auth code", "fix the dark mode styling", "plan the migration"). Used only to
// suppress AUTO-routing (an explicit pick always wins); never affects the gate or single-mode behavior.
// Inspection/meta verbs PLUS question-words — the latter are safe to include because META_OBJECT must
// ALSO match a GODCLAUDE-system object, so "how do I deploy to k8s" (no system object) is NOT flagged.
const META_VERB = /\b(evaluat\w*|review\w*|assess\w*|audit\w*|analy[sz]\w*|inspect\w*|explain\w*|describ\w*|compar\w*|harmoni[sz]\w*|document\w*|summari[sz]\w*|understand\w*|improv\w*|refactor\w*|plan\w*|research\w*|show|list|map|how|what|why|which|whether|should|can|could|would|does|do)\b/i;
// GODCLAUDE-SYSTEM objects ONLY (not generic "X mode") — godclaude/godmode(s)/godsense/godmonitor/autopilot,
// "the [adj] modes", "mode(s) switching/harmonizing/collaborating", "the mode system", combineGateConfigs,
// or a god* trigger named as a topic. Kept tight so ordinary tasks never match this object set.
// NOTE: "the modes" is matched ONLY in its bare form (no pre-qualifier) and NOT "the modes of X" — so
// generic English like "the payment/permission/transport modes" or "the modes of operation" is NOT
// flagged as GODCLAUDE-meta (that was a false-positive class that suppressed real tasks).
const META_OBJECT = /\b(god ?claude|god ?modes?|god ?sense|god ?monitor|autopilot|deterministic\s+(operating|contract|layer)|the\s+modes\b(?!\s+of\b)|modes?[- ]?(switch\w*|harmoni[sz]\w*|collaborat\w*)|how\s+the\s+modes\b|the\s+mode\s+system|combinegateconfigs|\b(goddev|godscout|goddata|godqa|godreview|godplan|godship|godsite|godbug|godpixel)\b)/i;
function isMetaPrompt(text) {
  const t = String(text || '');
  return META_OBJECT.test(t) && META_VERB.test(t);
}
// Decide the mode for THIS prompt given the current mode. Returns a mode name to SWITCH to (a god mode,
// or 'general' to drop to normal Claude), or null to STAY in the current mode. Auto-routing runs only
// under AUTO-PILOT (the single switch now — godsense/godsession were merged in), so callers pass
// aggressive:true and the routing policy is "re-evaluate every turn, keep context":
//   - A confident specific signal (senseMode) ALWAYS wins — it switches even across god modes (a dev
//     task in reviewer mode reroutes to developer), so the active mode tracks the current task.
//   - SUBSTANTIVE but unsignalled => escalate general -> the DEFAULT work mode, but STAY if already in a
//     god mode (an ambiguous follow-up like "now add edge cases" keeps qa — preserves task context).
//   - EASY (greeting/ack/very short) => STAY (never churn an active mode off a trivial turn).
// (The conservative `aggressive:false` branch below is retained for direct/test callers; under autopilot
//  it is never taken because autopilot implies aggressive.)
function routeMode(prompt, currentMode, opts) {
  // META-PROMPT guard (conservative): a prompt that is ABOUT the GODCLAUDE layer / its modes themselves
  // (evaluate/review/plan/show … godclaude / the modes / mode-switching / autopilot / godmonitor) is a
  // DISCUSSION of the system, not a task to route — so autopilot STAYS PUT (an explicit /<mode> pick still
  // wins; this only suppresses auto-routing). Deliberately NARROW: the object must be a GODCLAUDE-system
  // term, so real tasks ("deploy to kubernetes", "review the auth code", "fix the dark mode styling") are
  // NOT caught. Applies before both the confident-signal and default-fallback paths.
  if (isMetaPrompt(prompt)) return null;
  const sensed = senseMode(prompt);
  if (sensed) return sensed.mode;                        // a confident signal always wins (switches across god modes)
  if (!opts || !opts.aggressive) return null;            // conservative (non-autopilot/test): don't churn on weak signals
  // EASY => never force OR churn a mode: a fresh general session STAYS general (normal Claude for the
  // trivial prompt), and a mid-task ack does NOT drop an active god mode (the proof gate already exempts
  // trivial/non-mutating turns, so the god mode costs nothing there — and we avoid losing task context).
  if (easyPrompt(prompt)) return null;
  // SUBSTANTIVE => a god mode: escalate general -> the default work mode; stay if already in a god mode.
  return (currentMode && currentMode !== 'general') ? null : DEFAULT_MODE;
}

// AUTO-PILOT is the SINGLE auto-routing switch. The old `godsense` (`sense` flag) and `godsession`
// (`session` flag) toggles were MERGED INTO autopilot (they were redundant sub-toggles of the same
// engine) — there is no longer a separate sense/session toggle. Auto-routing is ON for a session iff
// the `autosession` (autopilot) flag is on, resolved per-session (overlay) then global; per-session
// overridable. When on, routing senses each prompt and switches modes — a confident signal switches
// (even across god modes), an ambiguous/easy follow-up keeps the current mode (preserves task context).
function autoSessionEnabled(home, sid) {
  if (STATE) { try { return STATE.flagOn(home || R.homeDir(), sid || '', 'autosession'); } catch (_) {} }
  try { return fs.existsSync(`${home || R.homeDir()}/.claude/godmode-autosession`); } catch (_) { return false; }
}
// Back-compat name the hooks already call to ask "is auto-routing on for this session?" — post-merge
// that is exactly autopilot. (Kept as an alias so inject-anti-drift/godmonitor call sites are unchanged.)
function senseEnabled(home, sid) { return autoSessionEnabled(home, sid); }

module.exports = { senseMode, routeMode, easyPrompt, isMetaPrompt, senseEnabled, autoSessionEnabled, DEFAULT_MODE, SIGNALS, THRESHOLD, MARGIN };
