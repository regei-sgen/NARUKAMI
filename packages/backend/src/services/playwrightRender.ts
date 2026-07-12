// Real-render service: drives a genuine Firefox (Gecko) or WebKit engine via
// Playwright and streams JPEG frames of a page over a WebSocket, forwarding the
// client's clicks / scroll / typing back into the page. This is what makes the
// Browser view show ACTUAL Firefox / WebKit pixels instead of UA-emulated
// Chromium. Browsers are launched lazily and reused across sessions.

import fs from 'node:fs';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import type { WebSocket } from 'ws';
import {
  clampPoint,
  deviceProfile,
  normalizeRenderUrl,
  parseRenderMsg,
  resolveRenderEngine,
  type RenderEngine,
} from './playwrightRenderCore';

// Playwright is loaded LAZILY (dynamic import) so the backend still boots if the
// package is missing or broken — real render just reports unavailable instead of
// crashing the whole app at startup (ws.ts imports this module unconditionally).
type PwModule = typeof import('playwright');
let pwPromise: Promise<PwModule | null> | null = null;
function loadPlaywright(): Promise<PwModule | null> {
  if (!pwPromise) pwPromise = import('playwright').then((m) => m).catch(() => null);
  return pwPromise;
}
async function engineType(engine: RenderEngine): Promise<BrowserType | null> {
  const pw = await loadPlaywright();
  return pw ? pw[engine] : null;
}

// How often a live session recaptures the page (ms). ~3 fps keeps it feeling
// live without pinning a CPU core rendering a preview.
const FRAME_INTERVAL_MS = 350;
// After an interaction, grab a fresh frame quickly so it feels responsive.
const INPUT_SETTLE_MS = 120;
const NAV_TIMEOUT_MS = 20_000;
// Close an idle engine this long after its last session ends, to free memory.
const BROWSER_IDLE_MS = 3 * 60_000;

const browsers: Partial<Record<RenderEngine, Browser>> = {};
const sessionCounts: Record<RenderEngine, number> = { firefox: 0, webkit: 0 };
const idleTimers: Partial<Record<RenderEngine, NodeJS.Timeout>> = {};

/** Whether the browser binary for an engine is actually installed on disk. */
export async function renderAvailable(engine: RenderEngine): Promise<boolean> {
  const et = await engineType(engine);
  if (!et) return false;
  try {
    const p = et.executablePath();
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

async function getBrowser(engine: RenderEngine): Promise<Browser> {
  const existing = browsers[engine];
  if (existing && existing.isConnected()) return existing;
  const et = await engineType(engine);
  if (!et) throw new Error('Playwright is not available on the server.');
  const browser = await et.launch({ headless: true });
  browsers[engine] = browser;
  return browser;
}

function retainBrowser(engine: RenderEngine): void {
  sessionCounts[engine] += 1;
  const t = idleTimers[engine];
  if (t) {
    clearTimeout(t);
    delete idleTimers[engine];
  }
}

function releaseBrowser(engine: RenderEngine): void {
  sessionCounts[engine] = Math.max(0, sessionCounts[engine] - 1);
  if (sessionCounts[engine] === 0 && !idleTimers[engine]) {
    idleTimers[engine] = setTimeout(() => {
      delete idleTimers[engine];
      if (sessionCounts[engine] === 0) {
        const b = browsers[engine];
        delete browsers[engine];
        b?.close().catch(() => {});
      }
    }, BROWSER_IDLE_MS);
  }
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/**
 * Drive one WS connection: wait for an `open` message, launch/reuse the engine,
 * navigate, and stream frames until the socket closes. Each connection owns one
 * BrowserContext + Page (isolated storage), so sessions never bleed into each
 * other. The heavy Browser is shared and reference-counted.
 */
export async function handleRenderConnection(ws: WebSocket): Promise<void> {
  let engine: RenderEngine | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let viewport = { w: 0, h: 0 };
  let loop: NodeJS.Timeout | null = null;
  let capturing = false;
  let closed = false;
  // True only after this session actually incremented the shared browser
  // refcount, so teardown releases exactly once (and never a count it never took
  // — a spurious release could idle-close a browser another session is using).
  let retained = false;

  const capture = async (): Promise<void> => {
    if (capturing || !page || ws.readyState !== ws.OPEN) return;
    capturing = true;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 55 });
      send(ws, { type: 'frame', mime: 'image/jpeg', data: buf.toString('base64'), w: viewport.w, h: viewport.h });
    } catch {
      /* page navigating / closed between checks — next tick retries */
    } finally {
      capturing = false;
    }
  };
  const soon = (): void => {
    setTimeout(() => void capture(), INPUT_SETTLE_MS);
  };

  const teardown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (loop) clearInterval(loop);
    loop = null;
    try {
      await context?.close();
    } catch {
      /* noop */
    }
    if (retained && engine) {
      releaseBrowser(engine);
      retained = false;
    }
  };

  const open = async (engineId: string, url: string, w: number, h: number): Promise<void> => {
    engine = resolveRenderEngine(engineId);
    if (!engine) {
      send(ws, { type: 'error', message: 'This browser renders natively — real render is only for Firefox and Safari.' });
      return;
    }
    if (!(await renderAvailable(engine))) {
      send(ws, {
        type: 'error',
        needsInstall: true,
        message: `Real ${engine === 'firefox' ? 'Firefox' : 'WebKit'} isn't installed yet. Install it once, then reopen real render.`,
      });
      // Reset so a retry on this same socket (after installing) isn't blocked by
      // the duplicate-open guard, which keys on `engine` being set.
      engine = null;
      return;
    }

    const profile = deviceProfile(engineId, w, h);
    viewport = { w: profile.width, h: profile.height };
    try {
      // The browser launch below can take seconds (cold start); the socket may
      // close mid-flight. Bail at each commit point so we never leak a context /
      // orphan the frame loop / pin the shared browser for a dead session.
      if (closed) return;
      retainBrowser(engine);
      retained = true;
      const browser = await getBrowser(engine);
      if (closed) return; // teardown already released via `retained`
      context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
        userAgent: profile.userAgent,
      });
      page = await context.newPage();
    } catch (err) {
      send(ws, { type: 'error', message: `Couldn't start real ${engine}: ${(err as Error).message}` });
      await teardown();
      return;
    }

    if (closed) {
      await context.close().catch(() => {});
      return;
    }
    send(ws, { type: 'ready', engine, w: viewport.w, h: viewport.h });
    await navigate(url);
    if (closed) {
      await context.close().catch(() => {});
      return;
    }

    // Start the live frame loop (an immediate first frame, then on an interval).
    void capture();
    loop = setInterval(() => void capture(), FRAME_INTERVAL_MS);
  };

  const navigate = async (rawUrl: string): Promise<void> => {
    const url = normalizeRenderUrl(rawUrl);
    if (!page || !url) return;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      send(ws, { type: 'loaderror', message: `Couldn't load ${url}: ${(err as Error).message}` });
    }
    soon();
  };

  const resize = async (w: number, h: number): Promise<void> => {
    if (!page) return;
    viewport = { w, h };
    try {
      await page.setViewportSize({ width: w, height: h });
    } catch {
      /* noop */
    }
    soon();
  };

  const doInput = async (msg: Extract<ReturnType<typeof parseRenderMsg>, { type: 'input' }>): Promise<void> => {
    if (!page) return;
    try {
      if (msg.kind === 'click' && typeof msg.x === 'number' && typeof msg.y === 'number') {
        const p = clampPoint(msg.x, msg.y, viewport.w, viewport.h);
        await page.mouse.click(p.x, p.y, { button: msg.button ?? 'left' });
      } else if (msg.kind === 'move' && typeof msg.x === 'number' && typeof msg.y === 'number') {
        const p = clampPoint(msg.x, msg.y, viewport.w, viewport.h);
        await page.mouse.move(p.x, p.y);
      } else if (msg.kind === 'scroll') {
        await page.mouse.wheel(msg.dx ?? 0, msg.dy ?? 0);
      } else if (msg.kind === 'key' && msg.key) {
        await page.keyboard.press(msg.key);
      } else if (msg.kind === 'text' && msg.text) {
        await page.keyboard.type(msg.text);
      }
    } catch {
      /* input raced with a navigation — ignore */
    }
    soon();
  };

  ws.on('message', (raw) => {
    // `ws` delivers frames as Buffers even for text messages — stringify first.
    const msg = parseRenderMsg(String(raw));
    if (!msg) return;
    switch (msg.type) {
      case 'open':
        if (!engine && !context) void open(msg.engineId, msg.url, msg.w, msg.h);
        break;
      case 'nav':
        void navigate(msg.url);
        break;
      case 'resize':
        void resize(msg.w, msg.h);
        break;
      case 'reload':
        void page?.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).then(soon).catch(() => {});
        break;
      case 'input':
        void doInput(msg);
        break;
      case 'close':
        void teardown().then(() => ws.close());
        break;
    }
  });
  ws.on('close', () => void teardown());
  ws.on('error', () => void teardown());
}

/** Close all live browsers (called on server shutdown). */
export async function shutdownRender(): Promise<void> {
  const all = Object.values(browsers).filter(Boolean) as Browser[];
  await Promise.all(all.map((b) => b.close().catch(() => {})));
}
