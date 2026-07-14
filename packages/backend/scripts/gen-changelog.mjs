// Snapshot this repo's git history into dist/changelog.json at build time.
// The packaged desktop app ships no .git, so routes/changelog.ts falls back to
// this bundled file (bundledChangelog(): dist/routes → ../changelog.json) — this
// is what keeps the installed app's Changelog in sync with the repo: every
// rebuild+install re-bakes the current history. Runs AFTER tsc so it can reuse
// the compiled gitLog service (same parser the live route uses). Fail-soft: no
// git / not a work tree → write [] and warn, never break the build.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const out = path.join(dist, 'changelog.json');

const require = createRequire(import.meta.url);
const { repoLog, resolveRepoRoot } = require(path.join(dist, 'services', 'gitLog.js'));
const { resolveChangelogRepo } = require(path.join(dist, 'config.js'));

// Same resolution as the live route: the Ace OS (OSOFT) clone first, falling
// back to NARUKAMI's own repo when no Ace workspace exists on the build machine.
const start = resolveChangelogRepo() ?? path.join(here, '..', '..', '..');
const root = (await resolveRepoRoot(start)) ?? start;
const commits = await repoLog(root, 500);

fs.writeFileSync(out, JSON.stringify(commits, null, 1), 'utf8');
if (commits.length === 0) {
  console.warn('[backend] gen-changelog: no git history found — wrote an EMPTY changelog.json');
} else {
  console.log(`[backend] wrote dist/changelog.json (${commits.length} commits, head ${commits[0].hash})`);
}
