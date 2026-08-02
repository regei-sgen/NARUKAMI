// Assembles the app directory (dist-app/) that electron-builder packages: the
// Electron main, a minimal package.json, and the built backend (which now
// includes the generated Prisma client + engine under dist/generated, a non-dot
// path electron-builder bundles cleanly). The backend's runtime node_modules are
// collected automatically by electron-builder from desktop/package.json
// "dependencies" — we don't stage node_modules ourselves (it prunes them anyway).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repoRoot = path.join(desktop, '..', '..');
const stage = path.join(desktop, 'dist-app');

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// Copy every compiled main-process module (main.js, preload.js, and any modules
// they require like framingHeaders.js) so no runtime `require('./…')` is missing.
// The preload in particular sits NEXT TO main.js in both dev and packaged
// layouts — main.ts resolves it as path.join(__dirname, 'preload.js'), so it
// must be staged or the PC Stats window loses its pin bridge in the installer.
const mainOut = path.join(desktop, 'dist-main');
for (const f of fs.readdirSync(mainOut)) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(mainOut, f), path.join(stage, f));
}
// Tray icon, likewise resolved next to main.js in the packaged app.
fs.copyFileSync(path.join(desktop, 'build', 'icon.png'), path.join(stage, 'tray-icon.png'));
fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: 'narukami-app', version: '1.0.0', main: 'main.js', private: true }, null, 2),
);

fs.cpSync(path.join(repoRoot, 'packages', 'backend', 'dist'), path.join(stage, 'backend', 'dist'), {
  recursive: true,
});

// Fail closed before electron-builder runs (package.json "dist" chains
// build:main && stage && electron-builder). The engine is what we stage; the
// rest are the extraResources electron-builder copies straight from the source
// tree — the packaged app resolves every one of them from process.resourcesPath
// with no fallback, so a missing file here ships as a broken installer.
const required = [
  ['prisma query engine', path.join(stage, 'backend', 'dist', 'generated', 'prisma', 'query_engine-windows.dll.node')],
  ['frontend build', path.join(repoRoot, 'packages', 'frontend', 'dist')],
  ['db template', path.join(repoRoot, 'packages', 'backend', 'prisma', 'dev.db')],
  ['mcp bridge', path.join(repoRoot, 'packages', 'backend', 'mcp-bridge.mjs')],
  ['broker agent', path.join(repoRoot, 'packages', 'backend', 'broker-agent.mjs')],
  ['godclaude assets', path.join(repoRoot, 'packages', 'backend', 'godclaude-assets')],
];
const missing = required.filter(([, p]) => !fs.existsSync(p));
if (missing.length) {
  for (const [label, p] of missing) console.error(`[stage] FATAL: ${label} missing at ${p}`);
  process.exit(1);
}
console.log('[stage] done →', stage);
