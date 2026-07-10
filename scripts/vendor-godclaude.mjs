#!/usr/bin/env node
// vendor-godclaude.mjs — snapshot the GODCLAUDE layer assets into this repo so
// NARUKAMI can provision its OWN embedded godclaude home (separate from the
// user's native ~/.claude install).
//
//   node scripts/vendor-godclaude.mjs [path-to-godclaude-repo]
//
// Copies the runtime subset (hooks, modes, contract, CLIs) into
// packages/backend/godclaude-assets/ and stamps VENDOR.json with the source
// version. Excluded on purpose: godmonitor-server.mjs + godmonitor-ui/ (NARUKAMI's
// Argus tab is the dashboard) and skills/ (Claude-config-dir switchers, not
// DET_HOOKS_HOME assets — the native ones keep working against the embedded state).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC_REPO = path.resolve(process.argv[2] || 'C:/Users/lloyd/godclaude');
const SRC = path.join(SRC_REPO, 'assets');
const DEST = path.join(REPO, 'packages', 'backend', 'godclaude-assets');

if (!fs.existsSync(SRC)) {
  console.error(`ERROR: godclaude assets not found at ${SRC}`);
  process.exit(1);
}

// Root-level files + dirs that make up the embeddable runtime.
const FILES = [
  'deterministic-contract.md',
  'godmode.mjs',
  'godmode-stats.mjs',
  'godmonitor.mjs',
  'godmode-statusline.mjs',
];
const DIRS = ['hooks', 'modes'];

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

let copied = 0;
for (const f of FILES) {
  fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
  copied++;
}
for (const d of DIRS) {
  fs.cpSync(path.join(SRC, d), path.join(DEST, d), { recursive: true });
  copied += fs.readdirSync(path.join(DEST, d), { recursive: true }).length;
}

let version = 'unknown';
try {
  version = JSON.parse(fs.readFileSync(path.join(SRC_REPO, 'package.json'), 'utf8')).version ?? 'unknown';
} catch {
  /* keep 'unknown' */
}

const manifest = {
  source: SRC_REPO.replace(/\\/g, '/'),
  version,
  vendoredAt: new Date().toISOString(),
  files: FILES,
  dirs: DIRS,
};
fs.writeFileSync(path.join(DEST, 'VENDOR.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`Vendored godclaude ${version} -> ${DEST} (${copied} entries)`);
