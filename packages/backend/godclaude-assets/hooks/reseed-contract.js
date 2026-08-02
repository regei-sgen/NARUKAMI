#!/usr/bin/env node
// reseed-contract.js — PostCompact. Re-injects the active mode's operating contract after a
// context compaction.
//
// The contract is emitted at SessionStart and again on a mode SWITCH, and nowhere else. Compaction
// discards it: what survives is the ~500-byte terse anti-drift reminder, so a long session silently
// continues under a contract the model can no longer see — and the Stop gate keeps enforcing that
// contract regardless. The failure is invisible from inside the session, which is the worst
// property a control can have.
//
// Deliberately reuses godmode-mode.js's resolver rather than re-reading the mode files, so this
// hook and the SessionStart injector can never disagree about which mode is active.
//
// Fail-OPEN on any error (emit nothing, exit 0).

'use strict';
const fs = require('node:fs');
const os = require('node:os');

const HOME = (process.env.DET_HOOKS_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const CLAUDE_DIR = (process.env.CLAUDE_CONFIG_DIR || `${HOME}/.claude`).replace(/\\/g, '/');
const AUDIT = `${CLAUDE_DIR}/hook-audit.log`;

let resolveModes, resolveMode, readModeAsset, handoffGuidance;
try { ({ resolveModes, resolveMode, readModeAsset, handoffGuidance } = require('./godmode-mode.js')); }
catch (_) { /* degraded shims below */ }
if (typeof resolveMode !== 'function') resolveMode = () => 'general';
if (typeof resolveModes !== 'function') resolveModes = (h, cwd, sid) => { try { return [resolveMode(h, cwd, sid)]; } catch (_) { return ['general']; } };
if (typeof readModeAsset !== 'function') readModeAsset = () => '';
if (typeof handoffGuidance !== 'function') handoffGuidance = () => '';

function audit(line) {
  try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [reseed] ${line}\n`); } catch (_) {}
}

function main(raw) {
  let d = {};
  try { d = JSON.parse(raw) || {}; } catch (_) { d = {}; }
  const sid = d.session_id;
  let modes = [];
  try { modes = resolveModes(HOME, d.cwd, sid) || []; } catch (_) { modes = []; }

  const parts = [];
  for (const m of modes) {
    if (!m || m === 'general') continue;
    let c = '';
    try { c = readModeAsset(HOME, m, 'contract.md') || ''; } catch (_) { c = ''; }
    if (c.trim()) parts.push(c.trim() + handoffGuidance(m));
  }
  if (!parts.length) { audit(`skip: no non-general contract to reseed (modes=${modes.join(',') || 'none'})`); return ''; }

  const body = parts.join('\n\n');
  audit(`RESEED modes=${modes.join(',')} bytes=${Buffer.byteLength(body, 'utf8')} sid=${String(sid || 'nosid').slice(0, 40)}`);
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostCompact',
      additionalContext:
        `[contract reseeded after compaction — the operating contract below was dropped from context ` +
        `by the compaction and still governs this session]\n\n${body}`,
    },
  });
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let out = '';
  try { out = main(data); } catch (_) { out = ''; }
  if (out) process.stdout.write(out);
  process.exit(0);
});
