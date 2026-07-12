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

// Blocking sleep (no async needed in this short build script).
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// On Windows a leftover dist-app can be momentarily locked (AV/Search indexer
// scanning the freshly-written .node engine, or a still-running instance), so a
// plain rmSync throws EBUSY/EPERM and aborts the whole build. Retry briefly
// before giving up rather than failing the packaging outright.
function rmrf(dir) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= 10 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err.code)) throw err;
      console.log(`[stage] ${err.code} removing dist-app, retrying (${attempt}/10)…`);
      sleepMs(300);
    }
  }
}

rmrf(stage);
fs.mkdirSync(stage, { recursive: true });

// Copy the ENTIRE compiled main-process output (main.js, preload.js, popout.js,
// and any future module they require) — not a hand-picked subset. Cherry-picking
// silently breaks the moment main.ts imports a new local module: the packaged
// `require('./thing')` then throws `Cannot find module` at load, which Electron
// surfaces as the opaque "A JavaScript error occurred in the main process".
fs.cpSync(path.join(desktop, 'dist-main'), stage, { recursive: true });
fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: 'narukami-app', version: '1.0.0', main: 'main.js', private: true }, null, 2),
);

fs.cpSync(path.join(repoRoot, 'packages', 'backend', 'dist'), path.join(stage, 'backend', 'dist'), {
  recursive: true,
});

const engine = path.join(stage, 'backend', 'dist', 'generated', 'prisma', 'query_engine-windows.dll.node');
console.log('[stage] prisma engine present:', fs.existsSync(engine));
console.log('[stage] done →', stage);
