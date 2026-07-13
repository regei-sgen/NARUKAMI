import { app, BrowserWindow, dialog, ipcMain, screen, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { rewriteFramingHeaders } from './framingHeaders';

const PACKAGED = app.isPackaged;

interface BackendStart {
  start: (o: { port: number; host: string; frontendDir: string }) => Promise<{ port: number }>;
}

/** Locate the built backend, frontend, and the template DB for dev vs packaged. */
function resolvePaths(): { backendIndex: string; frontendDir: string; templateDb: string } {
  if (PACKAGED) {
    const res = process.resourcesPath;
    return {
      // The staged app dir (dist-app/) ships inside the asar; native engines
      // (Prisma, node-pty) are asarUnpack'd next to it.
      backendIndex: path.join(app.getAppPath(), 'dist-app', 'backend', 'dist', 'index.js'),
      frontendDir: path.join(res, 'frontend'),
      templateDb: path.join(res, 'narukami-template.db'),
    };
  }
  // dev: dist-main → desktop → packages
  const packagesDir = path.join(__dirname, '..', '..');
  return {
    backendIndex: path.join(packagesDir, 'backend', 'dist', 'index.js'),
    frontendDir: path.join(packagesDir, 'frontend', 'dist'),
    templateDb: path.join(packagesDir, 'backend', 'prisma', 'dev.db'),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function startBackend(): Promise<string> {
  const { backendIndex, frontendDir, templateDb } = resolvePaths();
  const userData = app.getPath('userData');
  const dbPath = path.join(userData, 'narukami.db');

  // First launch: seed the DB from the bundled, already-migrated template.
  if (!fs.existsSync(dbPath) && fs.existsSync(templateDb)) {
    fs.copyFileSync(templateDb, dbPath);
  }

  process.env.NARUKAMI_EMBEDDED = '1';
  process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, '/')}`;
  process.env.RUNNER_TOKEN_FILE = path.join(userData, '.runner-token');

  // Packaged: point Prisma at the asarUnpack'd query engine explicitly so it
  // doesn't try to load the .dll.node from inside the read-only asar.
  if (PACKAGED) {
    const engine = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'dist-app',
      'backend',
      'dist',
      'generated',
      'prisma',
      'query_engine-windows.dll.node',
    );
    if (fs.existsSync(engine)) process.env.PRISMA_QUERY_ENGINE_LIBRARY = engine;
  }

  const port = await freePort();
  // Require the compiled backend AFTER env is set so Prisma + config pick it up.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const backend = require(backendIndex) as BackendStart;
  const res = await backend.start({ port, host: '127.0.0.1', frontendDir });
  return `http://127.0.0.1:${res.port}`;
}

/**
 * Let the Browser view frame LIVE external sites. Almost every real site sends
 * `X-Frame-Options` or a CSP `frame-ancestors` directive that forbids being
 * embedded, so a plain <iframe> renders blank — the whole point of this view is
 * previewing real sites, so strip those two framing controls. Scoped to
 * SUBFRAME responses only: the app's own top-level document and every non-frame
 * resource are left untouched, and only `frame-ancestors` is peeled out of the
 * CSP so the framed site keeps its other protections (script-src, etc.). This
 * is the standard Electron "frame-anywhere dev browser" approach; it's safe
 * here because the shell only frames URLs the user explicitly navigates to.
 */
function stripFramingHeaders(sess: Electron.Session): void {
  sess.webRequest.onHeadersReceived((details, callback) => {
    const next = rewriteFramingHeaders(details.resourceType, details.responseHeaders);
    callback(next ? { responseHeaders: next } : {});
  });
}

let appUrl = '';
let mainWindow: BrowserWindow | null = null;
// runId → the window it was torn off into (dedupe: a repeat tear-off just focuses
// the existing window).
const popouts = new Map<string, BrowserWindow>();
// win.id → the runId a torn-off window currently shows. Kept current across a
// restart (which re-keys the run) so the right runId is re-docked.
const windowRunId = new Map<number, string>();
// The main window's terminal dock, in its own content-viewport coordinates (the
// renderer reports it). Converted to screen space on demand for drop detection.
let dockViewportRect: { x: number; y: number; width: number; height: number } | null = null;

const PRELOAD = path.join(__dirname, 'preload.js');

// The main window's terminal dock in screen coordinates, or null if there's no
// dock / no main window. Recomputed fresh each check so it tracks a moved window.
function screenDockRect(): { x: number; y: number; width: number; height: number } | null {
  if (!dockViewportRect || !mainWindow || mainWindow.isDestroyed()) return null;
  const content = mainWindow.getContentBounds();
  return {
    x: content.x + dockViewportRect.x,
    y: content.y + dockViewportRect.y,
    width: dockViewportRect.width,
    height: dockViewportRect.height,
  };
}

// Is the OS cursor currently over the main window's dock? Drives the drop hint
// and the re-dock decision while a torn-off window is dragged.
function cursorOverDock(): boolean {
  const r = screenDockRect();
  if (!r) return false;
  const p = screen.getCursorScreenPoint();
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

// Last dockhint value actually sent. win.on('move') fires per position change
// during a drag (hundreds/sec on high-polling mice) and the hint is almost
// always unchanged — dedupe here so the main renderer isn't woken by a train
// of identical IPC messages mid-drag.
let lastDockHint = false;
function setDockHint(active: boolean): void {
  if (active === lastDockHint) return;
  lastDockHint = active;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('narukami:dockhint', active);
  }
}

/**
 * Forward REAL window visibility to the renderer. backgroundThrottling:false
 * (deliberate — live terminals must keep streaming) has a side effect: it pins
 * document.visibilityState to 'visible', so the Page Visibility API can never
 * tell the SPA it was minimized. Without this signal every poll loop, pulse
 * animation, and cursor blink runs at full rate for a window nobody can see.
 * The renderer subscribes via window.narukami.onVisibility and pauses its
 * cosmetic/polling work while hidden; websocket streaming is unaffected.
 */
function wireVisibilitySignal(win: BrowserWindow): void {
  const send = (hidden: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send('narukami:visibility', hidden);
  };
  win.on('minimize', () => send(true));
  win.on('hide', () => send(true));
  win.on('restore', () => send(false));
  win.on('show', () => send(false));
}

// Hand a torn-off terminal back to the main window (re-dock). Idempotent on the
// renderer side, so calling it from both the drop and the close path is safe.
function reclaim(runId: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('narukami:reclaim', runId);
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#08080a',
    title: 'NARUKAMI',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // Never throttle the renderer when minimized/occluded: live terminals
      // keep streaming, and a throttled renderer would stall xterm writes and
      // idle/activity timers, then burst-replay them on restore (visible lag).
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  // Open external links in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  wireVisibilitySignal(win);
  await win.loadURL(appUrl);
  return win;
}

/**
 * Tear a terminal off into its own window. The pty lives in the backend keyed by
 * runId, so the window just loads the same SPA with `?popout=<runId>`, which
 * renders that one terminal full-window and reconnects its websocket. The tab is
 * removed from the main window (move semantics); dragging this window's title bar
 * back over the dock — or simply closing it — re-docks the terminal.
 */
function createTerminalWindow(runId: string, pos?: { x: number; y: number }): void {
  const existing = popouts.get(runId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 480,
    minHeight: 320,
    // Spawn under the cursor (offset so the title bar lands near the pointer),
    // so a drag-out feels like the terminal followed the mouse.
    ...(pos ? { x: Math.round(pos.x - 80), y: Math.round(pos.y - 12) } : {}),
    backgroundColor: '#050506',
    title: 'NARUKAMI — terminal',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // Same rationale as the main window: this IS a live terminal — never
      // throttle it when occluded or it would stall + burst-replay output.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  popouts.set(runId, win);
  windowRunId.set(win.id, runId);
  wireVisibilitySignal(win);

  // A torn-off window has a normal OS title bar. As the user drags it, light up
  // the dock's drop hint while the cursor is over it; on release there, re-dock.
  let redocked = false;
  win.on('move', () => setDockHint(cursorOverDock()));
  win.on('moved', () => {
    if (cursorOverDock()) {
      redocked = true;
      setDockHint(false);
      reclaim(windowRunId.get(win.id) ?? runId);
      win.close();
    } else {
      setDockHint(false);
    }
  });
  win.on('closed', () => {
    const current = windowRunId.get(win.id) ?? runId;
    windowRunId.delete(win.id);
    for (const [id, w] of popouts) if (w === win) popouts.delete(id);
    // Closing without a drop still returns the terminal (never strand a live pty).
    if (!redocked) reclaim(current);
    setDockHint(false);
  });

  void win.loadURL(`${appUrl}?popout=${encodeURIComponent(runId)}`);
}

/**
 * Self-update via electron-updater. Packaged builds only — in dev there is no
 * installer to replace. On a newer version the installer is downloaded in the
 * background, then the user is asked to restart. Every failure is swallowed:
 * a missing/unreachable update feed must never crash or block the app.
 */
function setupAutoUpdate(win: BrowserWindow): void {
  if (!PACKAGED) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Full-file downloads only: keeps a plain local/static feed simple (no HTTP
  // Range support needed on the server).
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on('update-downloaded', (info) => {
    void dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `NARUKAMI ${info.version} is ready to install`,
        detail: 'Restart NARUKAMI to apply the update. It will also install automatically next time you quit.',
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on('error', (err) => {
    // Non-fatal: no feed configured yet, offline, etc. Keep the app running.
    console.error('[updater]', err?.message ?? err);
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] check failed:', err?.message ?? err);
    });
  };
  check();
  // Re-check every 15 min so a long-running window picks up a new local build
  // without a manual relaunch. (electron-updater pulls the feed; it does not
  // watch the filesystem.)
  setInterval(check, 15 * 60 * 1000);
}

// Renderer → main: tear a terminal off into its own window, spawned at the
// cursor when a screen position accompanies the drag-out.
ipcMain.on('narukami:popout', (_e, runId: unknown, pos: unknown) => {
  if (typeof runId !== 'string' || !runId) return;
  const p =
    pos && typeof pos === 'object' && 'x' in pos && 'y' in pos
      ? { x: Number((pos as { x: number }).x), y: Number((pos as { y: number }).y) }
      : undefined;
  createTerminalWindow(runId, p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : undefined);
});

// The main window reports its terminal dock's rectangle (viewport coordinates)
// whenever the layout changes, so drag-back drop detection knows the target.
ipcMain.on('narukami:dockrect', (_e, rect: unknown) => {
  if (rect && typeof rect === 'object' && 'width' in rect) {
    const r = rect as { x: number; y: number; width: number; height: number };
    dockViewportRect =
      r.width > 0 && r.height > 0
        ? { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) }
        : null;
  } else {
    dockViewportRect = null;
  }
});

// ---------------------------------------------------------------------------
// Browser-view preview logs: capture console + network activity of the preview
// iframes via the Chrome DevTools Protocol and stream it to the renderer. The
// renderer can't see into cross-origin iframes; the main process can, through
// webContents.debugger. Events are filtered to the watched preview origin so
// the app's own console/requests never leak into the panel.

interface PreviewConsoleEvent {
  kind: 'console';
  level: string;
  text: string;
}
interface PreviewNetEvent {
  kind: 'net';
  id: string;
  method: string;
  url: string;
  rtype: string;
}
interface PreviewNetDoneEvent {
  kind: 'netdone';
  id: string;
  status: number;
  mime: string;
}
interface PreviewNetFailEvent {
  kind: 'netfail';
  id: string;
  error: string;
}
type PreviewEvent = PreviewConsoleEvent | PreviewNetEvent | PreviewNetDoneEvent | PreviewNetFailEvent;

interface PreviewCaptureState {
  origin: string | null;
  contexts: Map<number, string>; // executionContextId → origin
  requests: Set<string>; // requestIds belonging to the watched origin
  // Rolling buffer of recent events. A newly-committed URL's iframe
  // navigations race the renderer's watch IPC (they fire before the new origin
  // is watched) — replaying fresh buffered events when a watch lands recovers
  // them (document requests especially).
  recent: Array<{ at: number; method: string; params: any }>;
  // Runtime/Network domains enabled? Left on only while a watch is (or was
  // very recently) active — an always-attached debugger with Network enabled
  // taxes EVERY renderer event (each terminal ws frame gets serialized
  // cross-process into the buffer above, ~125/sec per streaming shell).
  domainsEnabled: boolean;
  // Pending disable after an unwatch. Cancelled if a new watch arrives first,
  // preserving the unwatch→watch replay race window documented below.
  idleTimer: NodeJS.Timeout | null;
}
const previewCapture = new Map<number, PreviewCaptureState>(); // webContents.id → state
const PREVIEW_BUFFER_MAX = 300;
// Only replay buffered events younger than this. The raced events arrive
// within ~100ms of the watch IPC; a tight window keeps a reload's pre-reload
// rows from resurfacing after the panel clears.
const PREVIEW_REPLAY_MS = 1500;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** RemoteObject → short printable text for the console panel. */
function remoteObjectText(o: { type?: string; value?: unknown; description?: string; unserializableValue?: string }): string {
  if (o.unserializableValue !== undefined) return o.unserializableValue;
  if (o.value !== undefined) return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value);
  return o.description ?? o.type ?? '?';
}

function ensurePreviewDebugger(wc: Electron.WebContents): boolean {
  if (previewCapture.has(wc.id)) return true;
  try {
    wc.debugger.attach('1.3');
  } catch (err) {
    // Another debugger (e.g. DevTools in some configurations) may hold the
    // target; capture is then unavailable rather than fatal.
    console.error('[preview] debugger attach failed:', (err as Error)?.message ?? err);
    return false;
  }
  const state: PreviewCaptureState = {
    origin: null,
    contexts: new Map(),
    requests: new Set(),
    recent: [],
    domainsEnabled: false,
    idleTimer: null,
  };
  previewCapture.set(wc.id, state);
  const emit = (evt: PreviewEvent): void => {
    if (!wc.isDestroyed()) wc.send('narukami:preview-log', evt);
  };
  wc.debugger.on('message', (_e, method, params: any) => {
    // Context bookkeeping runs unconditionally — contexts created before a
    // watch begins must still be attributable once one does.
    if (method === 'Runtime.executionContextCreated') {
      state.contexts.set(params.context.id, String(params.context.origin ?? ''));
      return;
    }
    if (method === 'Runtime.executionContextsCleared') {
      state.contexts.clear();
      return;
    }
    // Only buffer methods processPreviewEvent can actually replay. Everything
    // else — webSocketFrameSent/Received (full terminal-stream payloads!),
    // dataReceived, loadingFinished — was dead weight retained 300 deep.
    if (!PREVIEW_METHODS.has(method)) return;
    state.recent.push({ at: Date.now(), method, params });
    if (state.recent.length > PREVIEW_BUFFER_MAX) state.recent.shift();
    if (state.origin) processPreviewEvent(state, emit, method, params);
  });
  wc.debugger.on('detach', () => {
    const s = previewCapture.get(wc.id);
    if (s?.idleTimer) clearTimeout(s.idleTimer);
    previewCapture.delete(wc.id);
  });
  return true;
}

// The only CDP methods processPreviewEvent handles — the buffer/replay path
// never needs anything else.
const PREVIEW_METHODS = new Set([
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFailed',
]);

// Turn the event firehose on/off with the watch lifecycle. Enabling is cheap
// and idempotent; disabling after PREVIEW_REPLAY_MS + slack keeps the
// documented unwatch→rewatch replay race intact while ensuring an abandoned
// preview panel doesn't leave every app event serializing cross-process forever.
function setPreviewDomains(wc: Electron.WebContents, state: PreviewCaptureState, on: boolean): void {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  if (on) {
    if (state.domainsEnabled) return;
    state.domainsEnabled = true;
    void wc.debugger.sendCommand('Runtime.enable').catch(() => undefined);
    void wc.debugger.sendCommand('Network.enable').catch(() => undefined);
    return;
  }
  if (!state.domainsEnabled) return;
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    state.domainsEnabled = false;
    if (wc.isDestroyed()) return;
    void wc.debugger.sendCommand('Network.disable').catch(() => undefined);
    void wc.debugger.sendCommand('Runtime.disable').catch(() => undefined);
  }, PREVIEW_REPLAY_MS + 1000);
}

function processPreviewEvent(
  state: PreviewCaptureState,
  emit: (evt: PreviewEvent) => void,
  method: string,
  params: any,
): void {
  {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        if (state.contexts.get(params.executionContextId) !== state.origin) return;
        const text = (params.args ?? []).map(remoteObjectText).join(' ');
        emit({ kind: 'console', level: String(params.type ?? 'log'), text });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails ?? {};
        if (d.executionContextId && state.contexts.get(d.executionContextId) !== state.origin) return;
        const text = d.exception?.description ?? d.text ?? 'Uncaught exception';
        emit({ kind: 'console', level: 'error', text });
        break;
      }
      case 'Network.requestWillBeSent': {
        // Subresources carry the preview doc as documentURL; the iframe's own
        // document navigation carries the PARENT page instead, so match those
        // by the request URL itself. The has() guard keeps buffer replay from
        // double-emitting a request that was already processed live.
        if (state.requests.has(params.requestId)) return;
        const fromPreviewDoc = originOf(String(params.documentURL ?? '')) === state.origin;
        const isPreviewNav =
          params.type === 'Document' && originOf(String(params.request?.url ?? '')) === state.origin;
        if (!fromPreviewDoc && !isPreviewNav) return;
        state.requests.add(params.requestId);
        emit({
          kind: 'net',
          id: params.requestId,
          method: params.request?.method ?? 'GET',
          url: params.request?.url ?? '',
          rtype: String(params.type ?? ''),
        });
        break;
      }
      case 'Network.responseReceived': {
        if (!state.requests.has(params.requestId)) return;
        emit({
          kind: 'netdone',
          id: params.requestId,
          status: Number(params.response?.status ?? 0),
          mime: String(params.response?.mimeType ?? ''),
        });
        break;
      }
      case 'Network.loadingFailed': {
        if (!state.requests.has(params.requestId)) return;
        state.requests.delete(params.requestId);
        emit({ kind: 'netfail', id: params.requestId, error: String(params.errorText ?? 'failed') });
        break;
      }
      default:
        break;
    }
  }
}

// Renderer → main: watch (or stop watching, url=null) a preview origin. The
// debugger attaches on the FIRST call either way, so events streaming before a
// commit land in the buffer and are replayed once an origin is watched.
ipcMain.on('narukami:preview-watch', (e, url: unknown) => {
  const wc = e.sender;
  const origin = typeof url === 'string' && url ? originOf(url) : null;
  if (!ensurePreviewDebugger(wc)) {
    if (origin) {
      wc.send('narukami:preview-log', {
        kind: 'console',
        level: 'warning',
        text: '[NARUKAMI] console/network capture unavailable (debugger attach failed)',
      } satisfies PreviewConsoleEvent);
    }
    return;
  }
  const state = previewCapture.get(wc.id)!;
  state.origin = origin;
  state.requests.clear();
  setPreviewDomains(wc, state, origin !== null);
  if (origin) {
    // Recover events that raced this watch (iframe document navigations fire
    // before the IPC lands). Replay runs the same origin filter; the
    // freshness cutoff keeps pre-navigation state from resurfacing.
    const emit = (evt: PreviewEvent): void => {
      if (!wc.isDestroyed()) wc.send('narukami:preview-log', evt);
    };
    const cutoff = Date.now() - PREVIEW_REPLAY_MS;
    const buffered = state.recent.splice(0, state.recent.length);
    for (const { at, method, params } of buffered) {
      if (at >= cutoff) processPreviewEvent(state, emit, method, params);
    }
  }
  // NOTE: the buffer is intentionally NOT cleared on unwatch — React's effect
  // cleanup fires previewWatch(null) AFTER the new iframes have started
  // loading, and wiping the buffer there would destroy the very events the
  // next watch needs to replay.
});

// A torn-off window restarted its run (restart re-keys it). Keep the current-runId
// mapping in sync so the right runId is re-docked on drop/close.
ipcMain.on('narukami:runchanged', (_e, oldRunId: unknown, newRunId: unknown) => {
  if (typeof oldRunId !== 'string' || typeof newRunId !== 'string' || !newRunId) return;
  const win = popouts.get(oldRunId);
  if (!win) return;
  popouts.delete(oldRunId);
  popouts.set(newRunId, win);
  windowRunId.set(win.id, newRunId);
});

// Single-instance guard: a second desktop launch would open the SAME userData
// SQLite DB as the first and the two would corrupt each other's run bookkeeping
// (each boot's reconcile marks the other's live runs 'exited'). Refuse the second
// instance and focus the existing window instead.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  try {
    // Let the Browser view frame external sites that would otherwise refuse
    // embedding (X-Frame-Options / CSP frame-ancestors).
    stripFramingHeaders(session.defaultSession);
    appUrl = await startBackend();
    const win = await createWindow();
    mainWindow = win;
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
    });
    setupAutoUpdate(win);
  } catch (err) {
    dialog.showErrorBox('NARUKAMI failed to start', String((err as Error)?.stack ?? err));
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().then((win) => {
        mainWindow = win;
        win.on('closed', () => {
          if (mainWindow === win) mainWindow = null;
        });
      });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
