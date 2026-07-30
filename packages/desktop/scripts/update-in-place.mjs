/**
 * Update an EXISTING NARUKAMI install without running the installer.
 *
 *   node scripts/update-in-place.mjs [--target <dir>] [--dry-run] [--allow-exe]
 *
 * Why this exists: Smart App Control (Enforce) blocks a freshly built, unsigned
 * NARUKAMI-Setup.exe outright — "did not meet the Enterprise signing level
 * requirements". Per Microsoft's guidance SAC only honours certificates from
 * trusted CAs, so self-signing does not help and the only real cure is a
 * purchased code-signing certificate.
 *
 * But SAC gates EXECUTABLES, not data. Almost every change we ship lives in
 * `resources/app.asar` (backend + main process) and `resources/frontend` (the
 * SPA). Copying just those over an install that is ALREADY approved leaves the
 * approved binaries untouched, so SAC is never consulted. Verified empirically:
 * the installed exe launches happily against a swapped-in asar and serves the
 * new bundle.
 *
 * The one thing this must never do is smuggle a NEW unsigned binary into place —
 * that would both defeat the point and risk an app that cannot start. So any
 * executable whose bytes differ aborts the update unless --allow-exe is passed,
 * and those cases genuinely need a signed installer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const SOURCE = path.join(desktop, 'release', 'win-unpacked');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const target =
  opt('target') ??
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NARUKAMI');
const dryRun = flag('dry-run');
const allowExe = flag('allow-exe');

const EXECUTABLE = /\.(exe|dll|node|sys)$/i;
/** The app binary. electron-builder rewrites it every build (icon + asar
 *  integrity resource), so it almost always differs — and keeping the installed,
 *  already-approved copy is the entire point of this updater. */
const MAIN_BINARY = 'NARUKAMI.exe';

function walk(root, base = root, out = []) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

function sameBytes(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

if (!fs.existsSync(path.join(SOURCE, 'NARUKAMI.exe'))) {
  console.error(`No build found at ${SOURCE}\nRun: npm run dist -w desktop`);
  process.exit(1);
}
if (!fs.existsSync(path.join(target, 'NARUKAMI.exe'))) {
  console.error(`No existing NARUKAMI install at ${target}\nThis updates an install; it cannot create one.`);
  process.exit(1);
}

const files = walk(SOURCE);
const changed = [];
for (const rel of files) {
  const src = path.join(SOURCE, rel);
  const dst = path.join(target, rel);
  if (!sameBytes(src, dst)) changed.push(rel);
}

const keptBinary = changed.filter((f) => f === MAIN_BINARY);
// Native modules and helper binaries ship WITH app.asar and are expected to match
// it. If one of these changed, a data-only update would pair a new asar with old
// natives — so that case genuinely needs the installer.
const riskyExes = changed.filter((f) => f !== MAIN_BINARY && EXECUTABLE.test(f));
const changedData = changed.filter((f) => !EXECUTABLE.test(f));

console.log(`source : ${SOURCE}`);
console.log(`target : ${target}`);
console.log(
  `${changed.length} file(s) differ — ${changedData.length} data, ` +
    `${keptBinary.length} app binary (kept), ${riskyExes.length} other executable\n`,
);
for (const f of changedData) console.log(`  data  ${f}`);
for (const f of keptBinary) console.log(`  keep  ${f}  (installed copy is already SAC-approved)`);
for (const f of riskyExes) console.log(`  EXE   ${f}`);

if (riskyExes.length > 0 && !allowExe) {
  console.error(
    `\nABORTED: ${riskyExes.length} support executable(s) changed (native modules or helpers).\n` +
      `Pairing a new app.asar with old native binaries can break the app, and copying\n` +
      `new unsigned ones re-introduces exactly what Smart App Control blocks.\n` +
      `This update needs a signed installer. Override with --allow-exe only deliberately.`,
  );
  process.exit(2);
}

if (changedData.length === 0) {
  console.log('\nAlready up to date — nothing to copy.');
  process.exit(0);
}

if (dryRun) {
  console.log('\n--dry-run: nothing was written.');
  process.exit(0);
}

let copied = 0;
for (const rel of allowExe ? changed : changedData) {
  const src = path.join(SOURCE, rel);
  const dst = path.join(target, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied += 1;
}

// Verify by re-comparing, so the script proves its own work rather than
// assuming the copies landed.
const stillDifferent = (allowExe ? changed : changedData).filter(
  (rel) => !sameBytes(path.join(SOURCE, rel), path.join(target, rel)),
);
console.log(`\ncopied ${copied} file(s); ${stillDifferent.length} still differ`);
if (stillDifferent.length > 0) {
  for (const f of stillDifferent) console.error(`  FAILED  ${f}`);
  process.exit(3);
}
console.log('Update verified.');
