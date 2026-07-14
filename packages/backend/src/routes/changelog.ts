import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { REPO_ROOT, resolveChangelogRepo } from '../config';
import { repoLog, resolveRepoRoot, type LogCommit } from '../services/gitLog';

// The packaged desktop app has no .git to read live. A build step may write a
// changelog.json next to the compiled backend — we fall back to it when a live
// `git log` finds nothing. If NEITHER a live repo NOR a bundled file is present
// we return an empty list (fail-soft) rather than erroring, so the panel just
// shows "no history".
function bundledChangelog(): LogCommit[] {
  const candidates = [
    path.join(__dirname, '..', 'changelog.json'), // dist/routes → dist/changelog.json
    path.join(__dirname, 'changelog.json'),
  ];
  for (const p of candidates) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(parsed)) return parsed as LogCommit[];
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

export async function changelogRoutes(app: FastifyInstance): Promise<void> {
  // The Ace OS (OSOFT) repo's commit history (dated), for the "Changelog" view —
  // NARUKAMI runs as the Ace OS workstation, so its changelog tracks that repo,
  // live from the local clone (github.com/dan-sgen-dev/OSOFT). The UI filters by
  // date/time range client-side. Auth is enforced globally in index.ts (the
  // onRequest hook token-gates every /api/* route), so no per-route guard is needed.
  app.get('/api/changelog', async () => {
    // 1) The Ace workspace clone, read live (NARUKAMI_CHANGELOG_REPO override,
    //    else ~/OSOFT / ~/Ace) — works in repo mode AND the installed desktop
    //    app, since the clone lives on disk either way.
    const aceRepo = resolveChangelogRepo();
    if (aceRepo) {
      const root = await resolveRepoRoot(aceRepo);
      if (root) {
        const live = await repoLog(root, 500);
        if (live.length) return { commits: live };
      }
    }
    // 2) The build-time snapshot (gen-changelog.mjs bakes it with the same
    //    resolution) — covers a machine without the Ace clone.
    const bundled = bundledChangelog();
    if (bundled.length) return { commits: bundled };
    // 3) Last resort: NARUKAMI's own history (original behavior), then [].
    const ownRoot = (await resolveRepoRoot(REPO_ROOT)) ?? REPO_ROOT;
    return { commits: await repoLog(ownRoot, 500) };
  });
}
