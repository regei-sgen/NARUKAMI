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

fs.copyFileSync(path.join(desktop, 'dist-main', 'main.js'), path.join(stage, 'main.js'));
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
