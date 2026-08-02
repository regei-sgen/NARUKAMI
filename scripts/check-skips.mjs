#!/usr/bin/env node
/**
 * Hold a vitest JSON report to the LAN-skip manifest in ./lan-gated-tests.mjs.
 *
 *   node scripts/check-skips.mjs <report.json> [<report.json> ...]
 *
 * Exit 0 = every test either ran, or was skipped for the one reason this repo
 * tolerates (no routable LAN interface) AND that reason was announced loudly.
 * Exit 1 = a silent skip, a skip while a LAN was in fact available, a manifest
 * entry that no longer exists, or NARUKAMI_REQUIRE_LAN=1 with no LAN.
 *
 * Env:
 *   NARUKAMI_REQUIRE_LAN=1  → treat a LAN-less machine as a failure. CI sets this
 *                             so a loopback-only runner goes RED instead of green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { detectLanIp, LAN_GATED_TESTS } from './lan-gated-tests.mjs';

const SKIPPED = new Set(['pending', 'skipped', 'todo']);

const reports = process.argv.slice(2);
if (reports.length === 0) {
  console.error('usage: node scripts/check-skips.mjs <vitest-report.json> ...');
  process.exit(2);
}

/** Normalise a report's absolute file name to a repo-package-relative posix path. */
function relFile(name) {
  const posix = String(name).replace(/\\/g, '/');
  const m = posix.match(/\/packages\/[^/]+\/(src\/.*)$/);
  return m ? m[1] : posix;
}

const seen = []; // { file, title, status }
let missingReport = false;

for (const rp of reports) {
  if (!fs.existsSync(rp)) {
    console.error(`[check-skips] FATAL: report not found: ${path.resolve(rp)}`);
    missingReport = true;
    continue;
  }
  const report = JSON.parse(fs.readFileSync(rp, 'utf8'));
  for (const f of report.testResults ?? []) {
    for (const a of f.assertionResults ?? []) {
      seen.push({ file: relFile(f.name), title: a.title, status: a.status });
    }
  }
}
if (missingReport) process.exit(1);

const lanIp = detectLanIp();
const hasLan = lanIp !== null;
const inManifest = (t) =>
  LAN_GATED_TESTS.some((m) => m.file === t.file && m.title === t.title);

const skipped = seen.filter((t) => SKIPPED.has(t.status));
const lanSkips = skipped.filter(inManifest);
const otherSkips = skipped.filter((t) => !inManifest(t));

// A manifest entry that no longer appears in ANY report means the manifest has
// drifted — the gate would then be silently guarding nothing.
const absent = LAN_GATED_TESTS.filter(
  (m) => !seen.some((t) => t.file === m.file && t.title === m.title),
);

const bar = '='.repeat(78);
let failed = false;

console.log(bar);
console.log(`[check-skips] ${seen.length} tests in ${reports.length} report(s)`);
console.log(`[check-skips] LAN interface: ${hasLan ? lanIp : 'NONE (loopback only)'}`);
console.log(`[check-skips] LAN-gated tests in manifest: ${LAN_GATED_TESTS.length}`);

if (absent.length > 0) {
  failed = true;
  console.error(bar);
  console.error(
    `[check-skips] FAIL: ${absent.length} manifest entr${absent.length === 1 ? 'y' : 'ies'} did not appear in the report.`,
  );
  console.error('  The test was renamed, moved or deleted. Update scripts/lan-gated-tests.mjs');
  console.error('  — until then this gate is guarding a test that no longer exists.');
  for (const m of absent) console.error(`    - ${m.file} :: ${m.title}`);
}

if (otherSkips.length > 0) {
  failed = true;
  console.error(bar);
  console.error(
    `[check-skips] FAIL: ${otherSkips.length} test(s) skipped for a reason this repo does not sanction.`,
  );
  console.error('  A skipped test is an unverified test. Un-skip it or justify it in the manifest.');
  for (const t of otherSkips) console.error(`    - ${t.file} :: ${t.title}`);
}

if (hasLan && lanSkips.length > 0) {
  failed = true;
  console.error(bar);
  console.error(
    `[check-skips] FAIL: this machine HAS a LAN interface (${lanIp}) yet ${lanSkips.length} LAN-gated test(s) still skipped.`,
  );
  console.error('  detectLanIp() in the test disagrees with the one in scripts/lan-gated-tests.mjs,');
  console.error('  or the test was hard-skipped. Either way the LAN paths went unverified.');
  for (const t of lanSkips) console.error(`    - ${t.file} :: ${t.title}`);
}

if (!hasLan) {
  // The loud banner. This is the whole point of the script: a run on a
  // loopback-only box must NEVER be able to look like a clean green.
  const lines = [
    '',
    '#'.repeat(78),
    '##',
    `##   ${LAN_GATED_TESTS.length} LAN TESTS DID NOT RUN — THIS RUN VERIFIED LESS THAN IT LOOKS LIKE`,
    '##',
    '##   No routable IPv4 interface was found, so every test behind',
    '##   `detectLanIp() !== null ? it : it.skip` self-skipped. The LAN relay,',
    '##   the mobile-share auth widening and the Host-forgery guard are all',
    '##   UNPROVEN by this run:',
    '##',
    ...LAN_GATED_TESTS.map((m) => `##     - ${m.file} :: ${m.title}`),
    '##',
    `##   Actually skipped in this report: ${lanSkips.length}/${LAN_GATED_TESTS.length}`,
    '##',
    '#'.repeat(78),
    '',
  ];
  console.error(lines.join('\n'));

  if (process.env.NARUKAMI_REQUIRE_LAN === '1') {
    failed = true;
    console.error(
      '[check-skips] FAIL: NARUKAMI_REQUIRE_LAN=1 and no LAN interface is present.',
    );
    console.error(
      '  Give the runner a routable interface, or drop NARUKAMI_REQUIRE_LAN and accept',
      '\n  that the LAN surface is untested on this box.',
    );
  }
}

if (!failed) {
  if (hasLan) {
    console.log(
      `[check-skips] OK: 0 skipped tests; all ${LAN_GATED_TESTS.length} LAN-gated tests ran.`,
    );
  } else {
    console.log(
      `[check-skips] OK (DEGRADED): only the ${lanSkips.length} sanctioned LAN skips above.`,
    );
  }
}
console.log(bar);
process.exit(failed ? 1 : 0);
