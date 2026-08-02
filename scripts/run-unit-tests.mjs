#!/usr/bin/env node
/**
 * The repo's single gated test step: run every workspace's UNIT suite
 * (integration tests excluded), emit a machine-readable report for each, then
 * hold those reports to the LAN-skip manifest via check-skips.mjs.
 *
 *   node scripts/run-unit-tests.mjs [--coverage]
 *
 * Why a script and not a chained npm string: a plain `vitest run` cannot tell you
 * that it went green by SKIPPING things. The JSON report can, and check-skips.mjs
 * turns that into a pass/fail. Reports are written to the OS temp dir so nothing
 * untracked lands in the working tree.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const withCoverage = process.argv.includes('--coverage');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-vitest-'));
const WORKSPACES = ['backend', 'frontend'];
const reports = [];
let failed = false;

for (const ws of WORKSPACES) {
  const report = path.join(outDir, `${ws}.json`);
  reports.push(report);
  const args = [
    'run',
    'test:unit',
    '-w',
    ws,
    '--',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${report}`,
  ];
  if (withCoverage) args.push('--coverage');

  console.log(`\n[run-unit-tests] ${ws}: npm ${args.join(' ')}\n`);
  const r = spawnSync('npm', args, { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    failed = true;
    console.error(`[run-unit-tests] ${ws} unit suite FAILED (exit ${r.status}).`);
  }
}

// Always run the skip audit, even after a failure — a run can be red for one
// reason and ALSO be silently skipping a whole surface, and you want both.
console.log('');
const check = spawnSync('node', [path.join(here, 'check-skips.mjs'), ...reports], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: false,
});
if (check.status !== 0) failed = true;

fs.rmSync(outDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
