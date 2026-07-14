// ===========================================================================
// NARUKAMI — headless production boot (no Electron, no Vite).
//
// This is the default way to RUN NARUKAMI (npm start / the /narukami skill):
// it serves the built SPA and the API same-origin on 127.0.0.1:4000, which is
// exactly the surface the Ace OS stack expects of its workstation — the
// ace-desktop supervisor fingerprints GET / and ADOPTS this server, and the
// OS dashboard's WORKSTATION face iframes it.
//
// Mirrors the Electron desktop invocation (packages/desktop/src/main.ts):
//   1. NARUKAMI_EMBEDDED=1 BEFORE require() so dist/index.js does not auto-run
//      its CLI main() (which would boot WITHOUT the SPA).
//   2. DATABASE_URL is set to the ABSOLUTE dev.db path (forward slashes) so
//      Prisma never resolves a relative sqlite path against the wrong cwd.
//   3. NARUKAMI_ACE_FINGERPRINT=1 makes the served index.html carry the
//      window.__WORKSTATION__ marker ace-desktop's identify() looks for
//      (loopback requesters only — same gate as the __NARUKAMI__ token).
//   4. start({ port, host, frontendDir }) serves the built SPA same-origin and
//      injects the bearer token via window.__NARUKAMI__ — no token baked into
//      the bundle, no Vite dev server at runtime.
// ===========================================================================
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const backendIndex = path.join(root, 'packages', 'backend', 'dist', 'index.js');
const frontendDir = path.join(root, 'packages', 'frontend', 'dist');

for (const [what, p] of [
  ['backend build (npm run build)', backendIndex],
  ['frontend build (npm run build)', path.join(frontendDir, 'index.html')],
]) {
  if (!fs.existsSync(p)) {
    process.stderr.write(`[narukami] missing ${what}: ${p}\n`);
    process.exit(1);
  }
}

// Stop dist/index.js from auto-running its own main() on require.
process.env.NARUKAMI_EMBEDDED = '1';

// Ace OS adoption fingerprint — see sendIndex in packages/backend/src/index.ts.
process.env.NARUKAMI_ACE_FINGERPRINT = process.env.NARUKAMI_ACE_FINGERPRINT ?? '1';

// Absolute DB path, like the Electron shell does. Set BEFORE require() so both
// dotenv (which never overrides an existing var) and Prisma pick it up.
if (!process.env.DATABASE_URL) {
  const dbPath = path.join(root, 'packages', 'backend', 'prisma', 'dev.db');
  process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, '/')}`;
}

const port = Number(process.env.PORT || 4000);

const backend = require(backendIndex);

backend
  .start({ port, host: '127.0.0.1', frontendDir })
  .then((res) => {
    process.stdout.write(
      `[narukami] NARUKAMI up: http://127.0.0.1:${res.port}/ ` +
        `(loopback only; SPA + API same-origin; token self-injected; Ace-adoptable)\n` +
        `[narukami] NOTE: if this process dies, all PTYs die with it — ` +
        `terminal tabs flip to error; recover per-tab with Restart / claude --continue.\n`,
    );
  })
  .catch((err) => {
    process.stderr.write(`[narukami] fatal startup error: ${String(err && err.stack ? err.stack : err)}\n`);
    process.exit(1);
  });
