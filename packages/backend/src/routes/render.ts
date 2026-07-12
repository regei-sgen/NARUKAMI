import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { renderAvailable } from '../services/playwrightRender';

const execFileAsync = promisify(execFile);

// Downloading two browser engines can take a few minutes on a slow link.
const INSTALL_TIMEOUT_MS = 8 * 60_000;

/** Resolve Playwright's install CLI so we can run it with the current Node. */
function playwrightCli(): string | null {
  for (const id of ['playwright/cli.js', 'playwright-core/cli.js']) {
    try {
      return require.resolve(id);
    } catch {
      /* try the next */
    }
  }
  return null;
}

export async function renderRoutes(app: FastifyInstance): Promise<void> {
  // Which real engines are installed and ready for the Browser view's real-render
  // mode. (Chromium-family browsers render natively in the webview, so they're
  // not listed here.)
  app.get('/api/render/status', async () => ({
    firefox: await renderAvailable('firefox'),
    webkit: await renderAvailable('webkit'),
  }));

  // One-time download of the Firefox + WebKit engines into the Playwright cache
  // (shared by the dev backend and the packaged app on this machine).
  app.post('/api/render/install', async (_req, reply) => {
    const cli = playwrightCli();
    if (!cli) {
      return reply.code(500).send({ error: 'Playwright is not installed on the server.' });
    }
    try {
      await execFileAsync(process.execPath, [cli, 'install', 'firefox', 'webkit'], {
        timeout: INSTALL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        ok: true,
        firefox: await renderAvailable('firefox'),
        webkit: await renderAvailable('webkit'),
      };
    } catch (err) {
      const e = err as Error & { stderr?: string };
      return reply.code(502).send({ error: `Browser install failed: ${e.message}`, detail: e.stderr ?? '' });
    }
  });
}
