#!/usr/bin/env node
/**
 * hash-vendor-assets.mjs — stamp (or verify) the content hash of the vendored
 * GODCLAUDE payload in packages/backend/godclaude-assets/.
 *
 *   node scripts/hash-vendor-assets.mjs           # recompute and WRITE into VENDOR.json
 *   node scripts/hash-vendor-assets.mjs --check   # verify only; exit 1 if stale
 *
 * WHY THIS EXISTS
 * ---------------
 * VENDOR.json's `version` is copied from the upstream godclaude repo's
 * package.json by scripts/vendor-godclaude.mjs. The backend uses it as a CACHE
 * KEY: `refreshIfProvisioned()` (packages/backend/src/services/godclaude.ts)
 * re-copies the payload into a user's god home only when the vendored stamp
 * differs from the one recorded at install time.
 *
 * That made hand-editing a vendored hook silent: the bytes change, `version`
 * does not, so every ALREADY-PROVISIONED user keeps running the old hook
 * forever. `contentHash` closes that hole — it is derived from the bytes, so it
 * cannot be forgotten, only left stale. `--check` in CI is what stops it being
 * left stale.
 *
 * THE HASH
 * --------
 * sha256 over a sorted, newline-delimited index of "<posix-relative-path> <sha256-of-file>",
 * covering exactly the entries VENDOR.json declares (`files` + a recursive walk
 * of `dirs`) — i.e. exactly what provision() copies. VENDOR.json itself is
 * excluded (it carries the hash, so including it would be circular).
 *
 * Sorting is by the posix path, so the digest is identical on Windows and POSIX.
 * The backend never recomputes this: it compares the stored string. That keeps
 * one implementation of the algorithm (this file) rather than two that can drift.
 *
 * LINE ENDINGS — why the bytes are normalised before hashing
 * ----------------------------------------------------------
 * This is not cosmetic; a raw-byte hash is WRONG here and was measured to be so.
 * .gitattributes sets `* text=auto eol=lf`, so a fresh checkout (CI, or any
 * clone) materialises these files with LF. But scripts/vendor-godclaude.mjs
 * copies them straight off a Windows source tree, so the machine that vendors
 * them can leave CRLF in its working tree — git still reports the file clean,
 * because it normalises on read. Measured on 2026-08-02 in this repo:
 * hooks/godmem-core.js was 7018 bytes in the worktree and 6887 in the index —
 * exactly its 131 line endings of difference.
 *
 * A raw-byte hash would therefore be stamped from CRLF locally and re-computed
 * from LF on the runner, and `--check` would fail in CI on a payload nobody
 * touched. So each text file's CRLF (and lone CR) are folded to LF before
 * hashing. Files containing a NUL byte are treated as binary and hashed raw —
 * today the payload is 100% text (md/js/json/txt/mjs), the guard is for later.
 *
 * The trade-off, stated plainly: a change that ONLY rewrites line endings does
 * not move this hash, so it will not trigger a re-provision. That is the
 * intended behaviour — for these JS/MD assets the line ending is a checkout
 * artifact, not a payload change, and hashing it would mean re-provisioning
 * every user every time the vendoring machine's git settings differed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ASSETS = path.join(REPO, 'packages', 'backend', 'godclaude-assets');
const VENDOR_JSON = path.join(ASSETS, 'VENDOR.json');

const check = process.argv.includes('--check');

/** Every file under `dir`, as posix paths relative to ASSETS, recursively. */
function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

const rel = (abs) => path.relative(ASSETS, abs).split(path.sep).join('/');

/**
 * Hash one file's CONTENT, independent of checkout line-ending policy.
 * Text: CRLF and lone CR folded to LF. Binary (contains NUL): raw bytes.
 * See the LINE ENDINGS note in the header for why this is not optional.
 */
function hashFile(abs) {
  const buf = fs.readFileSync(abs);
  const body = buf.includes(0) ? buf : Buffer.from(buf.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
  return crypto.createHash('sha256').update(body).digest('hex');
}

/**
 * Compute the payload digest. Returns { hash, count, index } — `index` is the
 * exact preimage, which makes a --check failure diffable instead of mysterious.
 */
export function computeContentHash(manifest) {
  const targets = [];
  for (const f of manifest.files ?? []) {
    const abs = path.join(ASSETS, f);
    if (!fs.existsSync(abs)) throw new Error(`VENDOR.json lists a missing file: ${f}`);
    targets.push(abs);
  }
  for (const d of manifest.dirs ?? []) {
    const abs = path.join(ASSETS, d);
    if (!fs.existsSync(abs)) throw new Error(`VENDOR.json lists a missing dir: ${d}`);
    targets.push(...walk(abs));
  }

  const lines = targets.map((abs) => `${rel(abs)} ${hashFile(abs)}`).sort();
  const index = lines.join('\n') + '\n';
  return {
    hash: 'sha256:' + crypto.createHash('sha256').update(index).digest('hex'),
    count: lines.length,
    index,
  };
}

function main() {
  if (!fs.existsSync(VENDOR_JSON)) {
    console.error(`ERROR: ${VENDOR_JSON} not found.`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(VENDOR_JSON, 'utf8'));

  let result;
  try {
    result = computeContentHash(manifest);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }

  if (check) {
    if (manifest.contentHash === result.hash) {
      console.log(`[hash-vendor-assets] OK — ${result.count} files, ${result.hash}`);
      return;
    }
    console.error('[hash-vendor-assets] STALE VENDOR.json contentHash.');
    console.error(`  recorded: ${manifest.contentHash ?? '(absent)'}`);
    console.error(`  actual:   ${result.hash}   (${result.count} files)`);
    console.error('');
    console.error('  The vendored godclaude payload changed without its stamp being updated.');
    console.error('  Already-provisioned users would keep running the OLD assets, because');
    console.error('  refreshIfProvisioned() re-copies only when the stamp moves.');
    console.error('');
    console.error('  Fix:  node scripts/hash-vendor-assets.mjs      (then commit VENDOR.json)');
    process.exit(1);
  }

  if (manifest.contentHash === result.hash) {
    console.log(`[hash-vendor-assets] unchanged — ${result.count} files, ${result.hash}`);
    return;
  }
  const previous = manifest.contentHash ?? '(absent)';
  manifest.contentHash = result.hash;
  fs.writeFileSync(VENDOR_JSON, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[hash-vendor-assets] updated — ${result.count} files`);
  console.log(`  was: ${previous}`);
  console.log(`  now: ${result.hash}`);
}

// Only run when executed directly, so computeContentHash stays importable.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
