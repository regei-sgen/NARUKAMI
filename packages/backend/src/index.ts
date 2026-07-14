import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { ALLOWED_ORIGINS, PORT } from './config';
import { getToken, requireAuth } from './auth';
import { projectRoutes } from './routes/projects';
import { runRoutes } from './routes/runs';
import { fileRoutes } from './routes/files';
import { workspaceRoutes } from './routes/workspace';
import { eodRoutes } from './routes/eod';
import { telemetryRoutes } from './routes/telemetry';
import { terminalRoutes } from './routes/terminals';
import { shareRoutes } from './routes/share';
import { changelogRoutes } from './routes/changelog';
import { setupWebSocket } from './ws';
import { reconcileStaleRuns } from './services/runner';
import { setBaseUrl } from './services/serverInfo';
import {
  hostAllowed,
  hostnameOf,
  isLoopbackHostname,
  resolveBindHost,
  setShareEnabled,
  setSharePort,
  SHARE_SETTING_KEY,
} from './services/share';
import { prisma, disconnectDb } from './db';

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
  const desiredPort = opts.port ?? PORT;
  const token = getToken();

  // Resolve "phone access" (LAN sharing) BEFORE binding. When enabled we listen
  // on 0.0.0.0 so a phone on the same Wi-Fi can reach the token-gated endpoints;
  // when off we stay loopback-only, exactly as the app has always behaved. An
  // explicit opts.host always wins (used by tests).
  let shareEnabled = false;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SHARE_SETTING_KEY } });
    shareEnabled = row ? JSON.parse(row.value) === true : false;
  } catch {
    shareEnabled = false;
  }
  setShareEnabled(shareEnabled);
  // When sharing is on, bind 0.0.0.0 even though the desktop shell passes
  // 127.0.0.1 — otherwise the phone can never reach us.
  const host = resolveBindHost(shareEnabled, opts.host);

  // Runs the previous process left as 'running' have dead ptys — reconcile them.
  const reconciled = await reconcileStaleRuns().catch(() => 0);
  if (reconciled > 0) {
    process.stdout.write(`[narukami] reconciled ${reconciled} stale run(s) from a prior session\n`);
  }

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

  // Request guard. Three zones:
  //  - /api  : reachable from loopback always, and from private-LAN only while
  //            phone sharing is on (hostAllowed); then requires the bearer token.
  //  - /m    : the phone page — same loopback/LAN reachability, but public HTML
  //            (no secrets; its own API/WS calls carry the token from the QR).
  //  - else  : the SPA + static assets. index.html carries the injected bearer
  //            token, so it must NEVER leave loopback, even when sharing is on.
  // WS auth is handled at the upgrade in ws.ts.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const pathname = (req.url || '').split('?')[0];
    if (pathname.startsWith('/ws')) return;

    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    const isMobile = pathname === '/m';
    if (isApi || isMobile) {
      if (!hostAllowed(req.headers.host)) {
        await reply.code(403).send({ error: 'Forbidden' });
        return;
      }
      if (isApi) await requireAuth(req, reply);
      return;
    }

    if (!isLoopbackHostname(hostnameOf(req.headers.host))) {
      await reply.code(403).send({ error: 'Forbidden' });
    }
  });

  await app.register(projectRoutes);
  await app.register(runRoutes);
  await app.register(fileRoutes);
  await app.register(workspaceRoutes);
  await app.register(eodRoutes);
  await app.register(telemetryRoutes);
  await app.register(terminalRoutes);
  await app.register(shareRoutes);
  await app.register(changelogRoutes);

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
  setSharePort(boundPort);

  // Record our own reachable URL so Claude runs can be handed an MCP bridge that
  // calls back in to read/drive other terminals.
  setBaseUrl(`http://${host}:${boundPort}`);

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
