// Local update feed for NARUKAMI's electron-updater.
// Serves packages/desktop/release/ (latest.yml + installer + blockmap) over
// http://127.0.0.1:<port>/ so an installed build can self-update from THIS
// machine — no cloud, no GitHub. Bound to loopback only, matching NARUKAMI's
// local-only security model.
//
// Loop:
//   1) bump "version" in package.json
//   2) npm run desktop:dist        (writes a new build into release/)
//   3) npm run serve:updates       (leave running)
//   4) launch the installed NARUKAMI -> it checks the feed, downloads,
//      and prompts to restart. A running window also re-checks every 15 min.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_DIR = path.join(here, '..', 'release');
const PORT = Number(process.env.NARUKAMI_UPDATE_PORT ?? 4210);

const TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const name = path.basename(decodeURIComponent((req.url || '/').split('?')[0]));
  const file = path.join(RELEASE_DIR, name);

  // Only serve real files that stay inside RELEASE_DIR (no path traversal).
  if (!name || !file.startsWith(RELEASE_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  const { size } = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(name)] ?? 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  if (!fs.existsSync(RELEASE_DIR)) {
    console.warn(`[update-feed] release dir missing: ${RELEASE_DIR}\n[update-feed] run "npm run desktop:dist" first.`);
  }
  console.log(`[update-feed] http://127.0.0.1:${PORT}/  ->  ${RELEASE_DIR}`);
});
