#!/usr/bin/env node
'use strict';
// godmonitor.mjs — on-demand health + activity report for the GODCLAUDE mode system.
//
//   node godmonitor.mjs          full human report (health, all-mode integrity, gate activity, heartbeats)
//   node godmonitor.mjs check    exit 0/1 on the health of the ACTIVE config (drift/broken active mode);
//                                "All modes" integrity is reported but does NOT affect this exit code
//   node godmonitor.mjs --json   machine-readable
//
// Honors DET_HOOKS_HOME (tests). Read-only; never edits anything.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const tryReq = (p) => { try { return require(p); } catch (_) { return null; } };
const core = require('./hooks/godmonitor-core.js'); // CJS: { healthCheck, auditAllModes, ... }
const SENSE = tryReq('./hooks/godsense-core.js');   // autoSessionEnabled (autopilot) — the single auto-routing switch
const STATE = tryReq('./hooks/godstate-core.js');   // envSid (the CLI's current session id)

const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const arg = (process.argv[2] || '').toLowerCase();
const SID = (STATE && STATE.envSid) ? STATE.envSid() : ((process.env.CLAUDE_CODE_SESSION_ID || '').match(/^[A-Za-z0-9._-]+$/) ? process.env.CLAUDE_CODE_SESSION_ID : '');
const _safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch (_) { return d; } };

// `dashboard` (aka serve/ui/live) launches GODMONITOR LIVE — the React localhost dashboard. It
// delegates to the sibling server (foreground; Ctrl-C stops it) and opens the browser by default. The
// rest of this CLI is the text report, so we exit before it runs.
if (['dashboard', 'serve', 'ui', 'live', 'web'].includes(arg)) {
  const here = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
  const serverPath = `${here}/godmonitor-server.mjs`;
  const rest = process.argv.slice(3);
  if (!rest.includes('--no-open') && !rest.includes('--open')) rest.push('--open');
  const r = spawnSync(process.execPath, [serverPath, ...rest], { stdio: 'inherit' });
  process.exit(r.status == null ? 0 : r.status);
}

const hc = core.healthCheck(HOME, process.cwd(), SID); // cwd engages path-gating; SID = THIS session's modes (else global)
const all = core.auditAllModes(HOME);
// routing posture: AUTOPILOT is the single auto-routing switch (godsense/godsession were merged into it).
const autopilot = SENSE && SENSE.autoSessionEnabled ? _safe(() => SENSE.autoSessionEnabled(HOME, SID), false) : false;
const effModes = (hc.effectiveModes || [hc.effective]).filter((m) => m && m !== 'general');
const effLabel = effModes.length ? effModes.join('+') : 'general';
const activity = core.gateActivity(HOME);
const heartbeats = core.readHeartbeatTail(HOME, 5);

if (arg === 'check') process.exit(hc.ok ? 0 : 1);
if (arg === '--json' || arg === 'json') {
  process.stdout.write(JSON.stringify({ health: hc, modes: all, activity, heartbeats, routing: { session: SID || null, effectiveModes: effModes, autopilot } }, null, 2) + '\n');
  process.exit(hc.ok ? 0 : 1);
}

const line = '─'.repeat(64);
const filesLabel = (m) => core.MODE_FILES.every(f => m.files[f]) ? 'ok' : 'MISSING';

console.log('GODMONITOR — GODCLAUDE mode health\n' + line);
console.log(`scope:      ${SID ? `session ${SID.slice(0, 8)}` : 'global (no session id)'}`);
console.log(`armed:      ${hc.armed ? 'yes' : 'no'}`);
console.log(`requested:  ${hc.requested || '(none → general)'}`);
console.log(`effective:  ${effLabel}${effModes.length > 1 ? `   (${effModes.length} modes running together — gate enforces the union)` : ''}`);
console.log(`routing:    autopilot:${autopilot ? 'ON' : 'off'}${autopilot ? '   (senses each task; god modes preferred, normal Claude only for easy prompts)' : '   (manual — modes change only when you select them or via the godmode: keyword)'}`);
const pathLine = hc.drift ? '⚠ LOST (requested != effective)'
  : hc.pathGatedDormant ? `dormant (path-gated: "${hc.requested}" is OFF outside its scope → ${JSON.stringify(hc.scopePaths)})`
  : hc.autoActivated ? `auto-activated by path (cwd is inside a scoped dir → ${hc.effective})`
  : 'OK (requested == effective)';
console.log(`path:       ${pathLine}`);
console.log(`status:     ${hc.ok ? '✅ healthy' : `⚠ ${hc.issues.length} issue(s)`}`);
if (!hc.ok) for (const i of hc.issues) console.log(`   - ${i}`);

console.log(line + '\nAll modes (integrity):');
if (!all.length) console.log('   (no modes/ folder found — only general is available)');
for (const m of all) console.log(`   ${m.ok ? '✅' : '⚠ '} ${m.mode.padEnd(13)} files:${filesLabel(m)}  gate.json:${m.gateValid ? 'valid' : 'INVALID'}` + (m.ok ? '' : `   <- ${m.issues.join('; ')}`));
const brokenInactive = all.filter(m => !m.ok && m.mode !== hc.effective);
if (hc.ok && brokenInactive.length) console.log(`   note: ${brokenInactive.length} inactive mode(s) above have integrity issues; "status"/"check" reflect only the ACTIVE mode (${hc.effective}).`);

console.log(line + '\nGate activity (per mode, from hook-audit.log — best effort):');
const modes = Object.keys(activity);
if (!modes.length) console.log('   (no gate decisions logged yet)');
else for (const m of modes) console.log(`   ${m.padEnd(13)} allow:${activity[m].allow}  block:${activity[m].block}`);

console.log(line + '\nRecent heartbeats:');
if (!heartbeats.length) console.log('   (none yet — start a session with a mode active)');
else for (const h of heartbeats) console.log(`   ${h.ts}  ${h.effective}${h.drift ? ' DRIFT' : ''}  ${h.ok ? 'ok' : `ISSUES:${(h.issues || []).length}`}`);

console.log(line + '\nDeep performance/latency: node ~/.claude/godmode-stats.mjs');
console.log('Live dashboard (React): node ~/.claude/godmonitor.mjs dashboard');
process.exit(hc.ok ? 0 : 1);
