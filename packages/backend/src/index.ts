import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { ALLOWED_ORIGINS, HOST, PORT } from './config';
import { getToken, isAllowedHost, requireAuth } from './auth';
import { projectRoutes } from './routes/projects';
import { runRoutes } from './routes/runs';
import { fileRoutes } from './routes/files';
import { workspaceRoutes } from './routes/workspace';
import { eodRoutes } from './routes/eod';
import { terminalRoutes } from './routes/terminals';
import { argusRoutes } from './routes/argus';
import { godclaudeRoutes } from './routes/godclaude';
import { vitalsRoutes } from './routes/vitals';
import { codeGraphRoutes } from './routes/codeGraph';
import { armoryRoutes } from './routes/armory';
import { setupWebSocket } from './ws';
import { pruneOldRunLogs, reconcileStaleRuns } from './services/runner';
import { startVitalsSampler } from './services/vitals';
import { sweepMcpConfigs } from './services/mcpConfig';
import { refreshIfProvisioned } from './services/godclaude';
import { anotherInstanceRunning, claimInstanceLock } from './services/instanceLock';
import { setBaseUrl } from './services/serverInfo';
import { disconnectDb, ensureSchema } from './db';

export interface StartOptions {
  port?: number;
  host?: string;
  /** If set, serve the built frontend (SPA) from this dir with the token injected. */
  frontendDir?: string;
}

export interface StartResult {
  app: FastifyInstance;
  token: string;
  host: string;
  port: number;
}

/**
 * Build + start the NARUKAMI backend. Used both by the CLI (`main` below) and
 * in-process by the Electron desktop shell (which passes a port + frontendDir).
 */
export async function start(opts: StartOptions = {}): Promise<StartResult> {
  const host = opts.host ?? HOST;
  const desiredPort = opts.port ?? PORT;
  const token = getToken();

  // Self-heal the schema for installs seeded by an older app version BEFORE any
  // query runs — the packaged app never migrates its copied SQLite DB, so a newly
  // added column (e.g. Run.claudeSessionId) would otherwise be missing and every
  // query that references it (Argus polls it ~2s) would fail with "no such column".
  await ensureSchema();

  // Runs the previous process left as 'running' have dead ptys — reconcile them.
  // BUT only if no other live instance is using this same database: otherwise we
  // would mark THAT instance's genuinely-running runs 'exited' (shared-SQLite
  // corruption). Single-instance guard is advisory/best-effort.
  if (anotherInstanceRunning()) {
    process.stderr.write(
      '[narukami] another instance appears to be using this database — ' +
        'skipping stale-run reconcile to avoid clobbering its live runs\n',
    );
  } else {
    try {
      const reconciled = await reconcileStaleRuns();
      if (reconciled > 0) {
        process.stdout.write(`[narukami] reconciled ${reconciled} stale run(s) from a prior session\n`);
      }
    } catch (err) {
      // Don't swallow silently — a failed reconcile leaves prior-session runs
      // wrongly marked 'running'.
      process.stderr.write(`[narukami] stale-run reconcile failed: ${String(err)}\n`);
    }
    // Retention: drop terminal logs of runs that ended >14 days ago (best-effort).
    try {
      const pruned = await pruneOldRunLogs();
      if (pruned > 0) {
        process.stdout.write(`[narukami] pruned ${pruned} run-log row(s) past retention\n`);
      }
    } catch (err) {
      process.stderr.write(`[narukami] run-log retention sweep failed: ${String(err)}\n`);
    }
    claimInstanceLock();
  }

  // Remove any per-run MCP config files (which embed a bearer token) left in the
  // temp dir by a prior session's now-dead Claude processes.
  sweepMcpConfigs();

  // If the embedded godclaude is installed, refresh its assets when this build
  // ships a newer vendored version (never auto-installs; best-effort).
  await refreshIfProvisioned();

  const app = Fastify({
    logger: {
      level: 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  // Tolerate empty JSON bodies (bodyless POSTs like /stop, /analyze).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.has(origin)) {
        cb(null, true);
        return;
      }
      // Accept any loopback origin — the packaged desktop app serves the SPA from
      // the backend itself, so the renderer's origin is http://127.0.0.1:<port>.
      try {
        const h = new URL(origin).hostname;
        if (h === '127.0.0.1' || h === 'localhost' || h === '[::1]') {
          cb(null, true);
          return;
        }
      } catch {
        /* fall through */
      }
      cb(new Error('Origin not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });

  // Host-header guard over the ENTIRE HTTP surface — not just /api. In packaged
  // mode the bearer token is injected into the served index.html, so a
  // DNS-rebinding page (evil.com rebound to 127.0.0.1) must never be able to
  // read ANY response and lift the token. Mirror the WS upgrade check in ws.ts:
  // loopback Host only. Legitimate clients always send a 127.0.0.1 / localhost /
  // [::1] Host; a rebound origin sends its own hostname and is rejected here.
  // Then: the /api surface is token-gated; static SPA assets remain public.
  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host)) {
      await reply.code(403).send({ error: 'Forbidden: non-loopback Host header.' });
      return;
    }
    if (req.method === 'OPTIONS') return;
    if (!req.url.startsWith('/api')) return;
    await requireAuth(req, reply);
  });

  await app.register(projectRoutes);
  await app.register(runRoutes);
  await app.register(fileRoutes);
  await app.register(workspaceRoutes);
  await app.register(eodRoutes);
  await app.register(terminalRoutes);
  await app.register(argusRoutes);
  await app.register(godclaudeRoutes);
  await app.register(vitalsRoutes);
  await app.register(codeGraphRoutes);
  await app.register(armoryRoutes);

  // Packaged desktop mode: serve the built frontend from this same server so the
  // renderer is same-origin. The bearer token is injected into index.html so the
  // SPA can authenticate without a baked-in .env.
  if (opts.frontendDir && fs.existsSync(path.join(opts.frontendDir, 'index.html'))) {
    const dir = opts.frontendDir;
    await app.register(fastifyStatic, { root: dir, prefix: '/', index: false, wildcard: false });
    const rawHtml = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const injected = rawHtml.replace(
      '</head>',
      `<script>window.__NARUKAMI__=${JSON.stringify({ token })};</script></head>`,
    );
    const sendIndex = (reply: FastifyReply) => reply.type('text/html').send(injected);
    app.get('/', async (_req, reply) => sendIndex(reply));
    // SPA fallback for any non-API GET that isn't a real asset file.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
        sendIndex(reply);
      } else {
        reply.code(404).send({ error: 'Not found' });
      }
    });
  }

  await app.listen({ host, port: desiredPort });
  setupWebSocket(app.server);

  const addr = app.server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : desiredPort;

  // Record our own reachable URL so Claude runs can be handed an MCP bridge that
  // calls back in to read/drive other terminals.
  setBaseUrl(`http://${host}:${boundPort}`);

  // Header vitals: sample whole-machine CPU/MEM in the background.
  startVitalsSampler();

  return { app, token, host, port: boundPort };
}

async function main(): Promise<void> {
  const { token, host, port } = await start();

  const line = '='.repeat(64);
  process.stdout.write(
    `\n${line}\n` +
      `  NARUKAMI backend is running\n` +
      `  HTTP + WS : http://${host}:${port}   (bound to ${host} only)\n` +
      `  Bearer token (also saved to .runner-token):\n` +
      `    ${token}\n` +
      `  The frontend reads it from packages/frontend/.env (VITE_RUNNER_TOKEN).\n` +
      `${line}\n\n`,
  );

  const shutdown = async (): Promise<void> => {
    try {
      await disconnectDb();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// Auto-run only as a standalone process (dev `tsx` / `node dist/index.js`).
// The Electron main sets NARUKAMI_EMBEDDED=1 and calls start() itself.
if (process.env.NARUKAMI_EMBEDDED !== '1') {
  main().catch((err) => {
    process.stderr.write(`Fatal startup error: ${String(err)}\n`);
    process.exit(1);
  });
}
