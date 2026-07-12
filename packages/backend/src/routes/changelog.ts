import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { REPO_ROOT } from '../config';
import { repoLog, type LogCommit } from '../services/gitLog';

// The packaged/installed app has no .git to read live, so the build step
// (desktop/scripts/stage.mjs) writes a changelog.json next to the compiled
// backend. We fall back to it when a live `git log` finds nothing.
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
  // This app's own commit history (dated), for the Blueprint "Changelog" panel.
  // The UI filters by date/time range client-side.
  app.get('/api/changelog', async () => {
    const live = await repoLog(REPO_ROOT, 500);
    const commits = live.length ? live : bundledChangelog();
    return { commits };
  });
}
