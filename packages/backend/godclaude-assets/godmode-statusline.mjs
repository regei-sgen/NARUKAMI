#!/usr/bin/env node
'use strict';
// godmode-statusline.mjs — Claude Code statusLine, two lines:
//   line 1 (where/what):  📁 dir/project · ⎇ git-branch* · Model·effort · god:mode
//   line 2 (resources):   ctx ██░░░░░░░░ 7% · 5h 20%  wk 36%   (omitted until the payload carries data)
//
// Claude Code runs this on each status render and pipes a JSON payload on stdin (session_id, cwd,
// model, workspace, ...). We resolve the active mode SET for that session through the SAME per-session
// store + multi-mode resolver the hooks use, so the bar shows exactly what the gate is enforcing —
// ONE mode, SEVERAL at once (e.g. "goddev+godqa"), or "general", plus an autopilot/godsession marker.
//
// Wired in settings.json as:  { "statusLine": { "type": "command", "command": "node \"~/.claude/godmode-statusline.mjs\"" } }
// FAST + FAIL-SAFE: any missing module / parse error / unarmed layer => a minimal, never-throwing line.
// Honors DET_HOOKS_HOME (tests). Respects NO_COLOR.

import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); // load the installed CJS resolver/store from ~/.claude/hooks

const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const HOOKS = `${HOME}/.claude/hooks`;
const NOCOLOR = !!process.env.NO_COLOR;
const c = (code, s) => (NOCOLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
const DIM = (s) => c('2', s), CYAN = (s) => c('36;1', s), YEL = (s) => c('33;1', s), GRN = (s) => c('32;1', s), MAG = (s) => c('35;1', s), RED = (s) => c('31;1', s);

// Usage segment — Claude Code (v2.1.x+) puts subscription rate limits on statusLine stdin as
//   input.rate_limits = { five_hour:{used_percentage,resets_at}, seven_day:{...}, seven_day_opus:{...}, ... }
// (the SAME server-side numbers `/usage` shows). Present ONLY for Pro/Max subscribers, and ONLY after the
// first API response of a session — absent/null early, so every field access is guarded and skipped if missing.
// Color: green <50%, yellow 50–80%, red ≥80%. Never throws → a bad payload just yields ''.
function usageSeg(rl) {
  if (!rl || typeof rl !== 'object') return '';
  const col = (p) => (p >= 80 ? RED : p >= 50 ? YEL : GRN);
  // Reset countdown from resets_at (epoch seconds) → dim "(1h42m)" / "(2d9h)". Countdown, not clock
  // time, so timezones never lie. Missing/past timestamps just omit it.
  const eta = (o) => {
    const left = o && typeof o.resets_at === 'number' ? o.resets_at * 1000 - Date.now() : NaN;
    if (!Number.isFinite(left) || left <= 0) return '';
    const m = Math.ceil(left / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    return DIM(`(${d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m % 60}m` : `${m}m`})`);
  };
  const seg = (label, o) => {
    const p = o && typeof o.used_percentage === 'number' ? Math.round(o.used_percentage) : null;
    return p === null ? null : col(p)(`${label} ${p}%`) + eta(o);
  };
  const parts = [seg('5h', rl.five_hour), seg('wk', rl.seven_day), seg('wk-opus', rl.seven_day_opus)].filter(Boolean);
  return parts.length ? parts.join(DIM('  ')) : '';
}

// Collector for the live meter: on every render that carries rate_limits, persist the latest snapshot to a
// SHARED file (~/.claude/usage-live.json) that the standalone `usage-meter.mjs` reads. Limits are account-wide,
// so the newest write from ANY session is authoritative. Never throws; never overwrites good data with an
// absent payload (a fresh/pre-first-response session must not wipe another session's numbers). Atomic
// temp-then-rename so a concurrent reader never sees a torn file.
function collect(input) {
  // Debug/introspection aid: keep the latest FULL stdin payload on disk so we can see exactly which
  // fields this Claude Code version provides to the statusline. Cheap, local, fail-safe.
  try { if (input && typeof input === 'object' && Object.keys(input).length) fs.writeFileSync(`${HOME}/.claude/statusline-last-input.json`, JSON.stringify({ ...input, __env: { COLUMNS: process.env.COLUMNS || null, LINES: process.env.LINES || null } }, null, 2)); } catch (_) {}
  try {
    if (!input || typeof input.rate_limits !== 'object' || !input.rate_limits) return;
    const rec = {
      ts: Date.now(),
      model: (input.model && input.model.display_name) || null,
      session_id: typeof input.session_id === 'string' ? input.session_id : null,
      rate_limits: input.rate_limits,
    };
    const dst = `${HOME}/.claude/usage-live.json`;
    const tmp = `${dst}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, dst);
  } catch (_) {}
}

// Directory/project segment — shows WHERE this session is working. Prefers the workspace project root
// (the dir Claude Code was launched from); when the session has cd'd below it, appends the current
// subfolder so both are visible ("proj/sub" for a direct child, "proj/…/leaf" deeper). Never throws.
function dirSeg(input) {
  try {
    const ws = (input && input.workspace) || {};
    const proj = typeof ws.project_dir === 'string' ? ws.project_dir : '';
    const cur = typeof input.cwd === 'string' && input.cwd ? input.cwd
      : (typeof ws.current_dir === 'string' ? ws.current_dir : '');
    const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const base = (p) => norm(p).split('/').pop() || norm(p);
    const root = proj || cur;
    if (!root) return '';
    let label = base(root);
    const np = norm(proj).toLowerCase(), nc = norm(cur).toLowerCase();
    if (proj && cur && nc !== np && nc.startsWith(np + '/')) {
      const rel = norm(cur).slice(np.length + 1);
      label += rel.includes('/') ? `/…/${base(cur)}` : `/${rel}`;
    }
    return MAG(`📁 ${label}`);
  } catch (_) { return ''; }
}

// Model segment — display name + reasoning effort ("Fable 5·xhigh"). Both straight off the payload;
// absent early in a session → segment omitted.
function modelSeg(input) {
  try {
    const name = input && input.model && typeof input.model.display_name === 'string' ? input.model.display_name : '';
    if (!name) return '';
    const eff = input.effort && typeof input.effort.level === 'string' ? input.effort.level : '';
    return c('1', name) + (eff ? DIM(`·${eff}`) : '');
  } catch (_) { return ''; }
}

// Context-window segment — 10-cell bar + % so compaction never sneaks up. Payload provides
// used_percentage directly (null before the first API response → segment omitted).
// Same color thresholds as the usage meters: green <50, yellow 50–79, red ≥80.
function ctxSeg(cw) {
  try {
    if (!cw || typeof cw.used_percentage !== 'number') return '';
    const p = Math.max(0, Math.min(100, Math.round(cw.used_percentage)));
    const col = p >= 80 ? RED : p >= 50 ? YEL : GRN;
    const fill = Math.round(p / 10);
    return `${DIM('ctx')} ${col('█'.repeat(fill) + '░'.repeat(10 - fill))} ${col(`${p}%`)}`;
  } catch (_) { return ''; }
}

// Churn segment — lines added/removed this session ("+39/−3"), off the payload's cost block.
// (The $ session cost was shown here once and removed on request.) Fields absent → segment omitted.
function costSeg(cost) {
  try {
    if (!cost || typeof cost !== 'object') return '';
    const a = cost.total_lines_added, r = cost.total_lines_removed;
    if (typeof a !== 'number' && typeof r !== 'number') return '';
    return GRN(`+${a || 0}`) + DIM('/') + RED(`−${r || 0}`);
  } catch (_) { return ''; }
}

// Git segment — "⎇ branch" (+ yellow * when dirty) for the session cwd. git can be slow on big repos
// and this script runs on every render, so results are cached on disk per-cwd with a 5s TTL — failures
// and non-repo dirs cache '' so a broken/slow git is paid at most once per TTL, never per render.
function gitSeg(cwd) {
  if (!cwd) return '';
  const CACHE = `${HOME}/.claude/statusline-git-cache.json`;
  const now = Date.now();
  let map = {};
  try { map = JSON.parse(fs.readFileSync(CACHE, 'utf8')) || {}; } catch (_) {}
  const hit = map[cwd];
  if (hit && typeof hit.ts === 'number' && now - hit.ts < 5000) return hit.seg || '';
  let seg = '';
  try {
    const out = execSync('git status --porcelain=v1 -b', { cwd, timeout: 800, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString();
    const head = out.split('\n', 1)[0] || '';
    let branch = head.startsWith('## ') ? head.slice(3).split('...')[0].trim() : '';
    if (branch.startsWith('No commits yet on ')) branch = branch.slice('No commits yet on '.length);
    if (/^HEAD( |$)|no branch/i.test(branch)) branch = 'detached';
    const dirty = out.split('\n').slice(1).some((l) => l.trim());
    if (branch) seg = GRN(`⎇ ${branch}`) + (dirty ? YEL('*') : '');
  } catch (_) { seg = ''; }
  try {
    map[cwd] = { ts: now, seg };
    for (const k of Object.keys(map)) if (!map[k] || typeof map[k].ts !== 'number' || now - map[k].ts > 3600000) delete map[k];
    const tmp = `${CACHE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map)); fs.renameSync(tmp, CACHE);
  } catch (_) {}
  return seg;
}

// Visible-cell width of a string as the terminal renders it: ANSI codes stripped, emoji/wide symbols
// (📁 ⚡ CJK …) counted as 2 cells, everything else 1. Used to right-align the god label against the
// terminal edge (Claude Code exports COLUMNS to this script since v2.1.153).
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visW(s) {
  let w = 0;
  for (const ch of String(s).replace(ANSI_RE, '')) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60)) ? 2 : 1;
  }
  return w;
}

// Guarded module loads — a partial/absent install just yields a quiet line, never a crash.
let R = null, STATE = null, SENSE = null;
try { R = require(`${HOOKS}/godmode-mode.js`); } catch (_) {}
try { STATE = require(`${HOOKS}/godstate-core.js`); } catch (_) {}
try { SENSE = require(`${HOOKS}/godsense-core.js`); } catch (_) {}

function render(data) {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) {}
  const sid = typeof input.session_id === 'string' ? input.session_id : '';
  const cwd = typeof input.cwd === 'string' ? input.cwd
    : (input.workspace && typeof input.workspace.current_dir === 'string' ? input.workspace.current_dir : '');
  const join = (parts) => parts.filter(Boolean).join(`  ${DIM('·')}  `);

  // god segment — same armed/mode/autopilot resolution as always; empty when godclaude isn't installed.
  let god = '';
  if (R && typeof R.resolveModes === 'function') {
    // Armed for THIS session? (env override, else the per-session/global store.) Dormant => faint "off".
    let armed = false;
    try {
      if (process.env.GODMODE_ACTIVE === '1') armed = true;
      else if (process.env.GODMODE_ACTIVE === '0') armed = false;
      else if (STATE && typeof STATE.armed === 'function') armed = STATE.armed(HOME, sid);
      else armed = fs.existsSync(`${HOME}/.claude/godmode-active`);
    } catch (_) {}
    if (!armed) god = DIM('god:off');
    else {
      // The active mode SET (multi-mode), path-gated + session-isolated, exactly like the gate sees it.
      let modes = ['general'];
      try { modes = R.resolveModes(HOME, cwd, sid); } catch (_) {}
      const PRIMARY = (R && R.PRIMARY) || {}, GODNAME = (R && R.GODNAME) || {};
      const real = modes.filter(m => m && m !== 'general');
      // Kami label: "Mahitotsu (Goddev)" per active mode — pseudonym + capitalized mode, with
      // NO "god:" prefix and NO autopilot marker (user preference; the autopilot state still lives
      // on the Argus godclaude panel). The god label is the width-PROTECTED segment (see the
      // RIGHT_PAD budgeting below), so a longer label simply drops the left dir/git/model segments
      // first in a tight window rather than truncating the mode.
      const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
      const fmt = (m) => GODNAME[m] ? `${GODNAME[m]} (${cap(PRIMARY[m] || m)})` : cap(PRIMARY[m] || m);
      const label = real.length ? real.map(fmt).join(' + ') : `${GODNAME.general || 'Amaterasu'} (${cap('general')})`;
      god = real.length ? CYAN(label) : DIM(label);
    }
  }

  // Line 1: left block (where/what) + god label shoved to the RIGHT edge. The TUI draws the status
  // row indented inside its frame, so the usable width is a few cells NARROWER than COLUMNS —
  // RIGHT_PAD=5 was calibrated from a real truncation (pad 2 overflowed by ~2-3 cells → "godd…").
  // The god label is the PROTECTED segment: when the window is tight, left segments are dropped
  // (model first, then git — the 📁 dir survives longest) before the label loses a character.
  const cols = parseInt(process.env.COLUMNS, 10);
  const RIGHT_PAD = 5;
  const usable = Number.isFinite(cols) && cols > 0 ? cols - RIGHT_PAD : null;
  // Branch + churn render as ONE unit ("⎇ main* +39/−3") so they sit beside each other and drop
  // together in tight windows; churn stands alone in that slot when cwd isn't a git repo.
  const gitChurn = [gitSeg(cwd), costSeg(input.cost)].filter(Boolean).join(' ');
  const leftParts = [dirSeg(input), gitChurn, modelSeg(input)].filter(Boolean);
  let line1;
  if (!god) line1 = join(leftParts);
  else if (usable === null) line1 = join([...leftParts, god]); // width unknown → inline, old behavior
  else {
    while (leftParts.length > 1 && visW(join(leftParts)) + 2 + visW(god) > usable) leftParts.pop();
    const left1 = join(leftParts);
    const gap = usable - visW(left1) - visW(god);
    if (gap >= 2) line1 = left1 + ' '.repeat(gap) + god;
    else if (left1 && visW(left1) + 5 + visW(god) <= usable) line1 = join([left1, god]);
    else line1 = god; // absurdly narrow: the god label alone, never truncated by us
  }

  // Line 2: resources — same degradation idea: rate limits drop in tight windows; ctx stays.
  let l2 = [ctxSeg(input.context_window), usageSeg(input.rate_limits)].filter(Boolean);
  if (usable !== null) while (l2.length > 1 && visW(join(l2)) > usable) l2.splice(1, 1);
  const line2 = join(l2);
  return line2 ? `${line1}\n${line2}` : line1;
}

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  try { collect(JSON.parse(data || '{}')); } catch (_) {}
  let out = ''; try { out = render(data); } catch (_) { out = ''; } process.stdout.write(out || ''); process.exit(0);
});
// If stdin never arrives (e.g. run with no pipe), don't hang forever — render with empty input shortly.
setTimeout(() => { let out = ''; try { out = render(data); } catch (_) { out = ''; } process.stdout.write(out || ''); process.exit(0); }, 1500).unref?.();
