#!/usr/bin/env node
// check-harness-parity.mjs — does the VENDORED godclaude payload match the LIVE harness?
//
// Why this exists: the payload in packages/backend/godclaude-assets/ is provisioned onto end users'
// machines, while day-to-day work edits the live tree at ~/.claude. Nothing compared them, so drift
// ran silently in BOTH directions and did real damage:
//   - hooks fixed in the live tree shipped stale to users (delegation gating, loop detection and the
//     injection scanner were all live-only for a while);
//   - fixes that landed in the payload during an audit were never propagated back, so the daily
//     driver ran WITHOUT them — and a later sync nearly overwrote them, because the person doing the
//     sync had no way to see which side was newer.
// A content hash (vendor:check) catches "the payload changed without a re-stamp". It cannot catch
// "the payload and the live tree disagree". This does.
//
// SCOPE: compares only files the payload actually ships. Hooks that exist solely in the live tree
// are a deliberate payload scope decision, not drift, and are reported separately as FYI.
//
// LINE ENDINGS ARE NORMALISED. .gitattributes is `* text=auto eol=lf`, so a checkout is LF while the
// live Windows tree is often CRLF; a raw byte compare reports every file as drifted and the check
// becomes noise everyone ignores.
//
// CI: there is no ~/.claude on a hosted runner, so this SKIPS (exit 0) when the live tree is absent.
// That is deliberate — it is a local developer gate, not a CI gate, and a skip says so out loud
// rather than pretending to have verified something.
//
//   node scripts/check-harness-parity.mjs            report
//   node scripts/check-harness-parity.mjs --fix-from-live   copy live -> payload (review the diff first!)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD = path.join(REPO, 'packages', 'backend', 'godclaude-assets');
const LIVE = path.join(os.homedir(), '.claude');
const fixFromLive = process.argv.includes('--fix-from-live');

const norm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

if (!fs.existsSync(LIVE) || !fs.existsSync(path.join(LIVE, 'hooks'))) {
  console.log('[harness-parity] SKIP — no live harness at ' + LIVE + ' (expected on CI).');
  process.exit(0);
}

// Every payload file, paired with where it lands in the live tree.
const pairs = [];
for (const f of fs.readdirSync(PAYLOAD)) {
  const p = path.join(PAYLOAD, f);
  if (fs.statSync(p).isFile() && f !== 'VENDOR.json') pairs.push([p, path.join(LIVE, f), f]);
}
for (const sub of ['hooks', 'modes']) {
  const dir = path.join(PAYLOAD, sub);
  if (!fs.existsSync(dir)) continue;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) walk(abs, r);
      else pairs.push([abs, path.join(LIVE, sub, ...r.split('/')), `${sub}/${r}`]);
    }
  };
  walk(dir, '');
}

const drift = [], missing = [];
for (const [payloadPath, livePath, label] of pairs) {
  if (!fs.existsSync(livePath)) { missing.push(label); continue; }
  try { if (norm(payloadPath) !== norm(livePath)) drift.push([label, payloadPath, livePath]); }
  catch { /* unreadable (binary/locked) → skip rather than false-alarm */ }
}

// FYI only: live-only hooks are a payload scope decision, not drift.
const liveOnly = fs.readdirSync(path.join(LIVE, 'hooks'))
  .filter((f) => /\.(js|mjs)$/.test(f) && !fs.existsSync(path.join(PAYLOAD, 'hooks', f)));

console.log(`[harness-parity] compared ${pairs.length} shipped file(s) against ${LIVE}`);
if (liveOnly.length) console.log(`  note: ${liveOnly.length} hook(s) exist only in the live tree (payload scope, not drift)`);

if (fixFromLive && drift.length) {
  for (const [label, payloadPath, livePath] of drift) {
    fs.copyFileSync(livePath, payloadPath);
    console.log(`  copied live -> payload: ${label}`);
  }
  console.log(`\n  ${drift.length} file(s) synced. Now run: npm run vendor:hash`);
  process.exit(0);
}

if (missing.length) {
  console.log(`\n  ${missing.length} shipped file(s) NOT present in the live tree:`);
  for (const m of missing) console.log(`    ${m}`);
}
if (!drift.length) {
  console.log('\n[harness-parity] OK — payload and live harness agree.');
  process.exit(missing.length ? 1 : 0);
}

console.log(`\n[harness-parity] DRIFT — ${drift.length} file(s) differ:`);
for (const [label] of drift) console.log(`    ${label}`);
console.log(
  `\n  The payload is what users get; the live tree is what you run. They must agree.\n` +
  `  Decide which side is NEWER before syncing — drift has run in both directions here, and\n` +
  `  copying the wrong way silently deletes fixes.\n\n` +
  `  Inspect:  git -C "${REPO}" diff -- packages/backend/godclaude-assets\n` +
  `  Sync:     node scripts/check-harness-parity.mjs --fix-from-live   (live -> payload)\n` +
  `  Re-stamp: npm run vendor:hash\n`
);
process.exit(1);
