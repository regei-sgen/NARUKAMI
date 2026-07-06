// The Prisma client is generated to src/generated/prisma (JS + query engine) and
// tsc doesn't copy non-TS files, so mirror it into dist/generated for the built
// backend (and for packaging).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src', 'generated');
const dest = path.join(here, '..', 'dist', 'generated');

fs.rmSync(dest, { recursive: true, force: true });
if (!fs.existsSync(src)) {
  console.error('[backend] src/generated missing — run `prisma generate` first');
  process.exit(1);
}
fs.cpSync(src, dest, { recursive: true, dereference: true });
console.log('[backend] copied generated Prisma client → dist/generated');
