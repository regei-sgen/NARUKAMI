// Generates (or reuses) the NARUKAMI bearer token and wires it into the frontend.
//
// - Ensures <root>/.runner-token exists (32 random bytes, hex).
// - Writes <root>/packages/frontend/.env with VITE_RUNNER_TOKEN so the SPA can
//   authenticate against the backend without a manual copy/paste step.
//
// The backend reads the SAME <root>/.runner-token at boot, so both sides agree.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tokenFile = path.join(root, '.runner-token');
const frontendEnv = path.join(root, 'packages', 'frontend', '.env');

let token = '';
if (fs.existsSync(tokenFile)) {
  token = fs.readFileSync(tokenFile, 'utf8').trim();
}

if (!token) {
  token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token, { encoding: 'utf8', mode: 0o600 });
  console.log('[narukami] generated a new runner token -> .runner-token');
} else {
  console.log('[narukami] reusing existing runner token from .runner-token');
}

fs.writeFileSync(frontendEnv, `VITE_RUNNER_TOKEN=${token}\n`, 'utf8');
console.log('[narukami] wrote packages/frontend/.env (VITE_RUNNER_TOKEN)');
