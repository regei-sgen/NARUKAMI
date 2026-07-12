import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { parseViewportPopoutParams, viewportPopoutKey } from './popout';

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

let appUrl = '';
let mainWindow: BrowserWindow | null = null;
// runId → the window it was torn off into (dedupe: a repeat tear-off just focuses
// the existing window).
const popouts = new Map<string, BrowserWindow>();
// win.id → the runId a torn-off window currently shows. Kept current across a
// restart (which re-keys the run) so the right runId is re-docked.
const windowRunId = new Map<number, string>();
// projectId → the window its Browser view was torn off into.
const browserPopouts = new Map<string, BrowserWindow>();
// Per-viewport pop-out windows, keyed by `${projectId}::${browserId}::${vpId}` so
// many can be open simultaneously (unlike the single whole-board window/project).
const viewportPopouts = new Map<string, BrowserWindow>();
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
// Drop zones the main window reports in its own content-viewport coordinates,
// converted to screen space on demand for drag-back detection: the terminal dock
// and the Browser view's drop area.
let dockViewportRect: Rect | null = null;
let browserDockRect: Rect | null = null;

const PRELOAD = path.join(__dirname, 'preload.js');

// Convert a rect in the main window's content-viewport coordinates to absolute
// screen coordinates. Recomputed fresh each check so it tracks a moved window.
function toScreenRect(vp: Rect | null): Rect | null {
  if (!vp || !mainWindow || mainWindow.isDestroyed()) return null;
  const c = mainWindow.getContentBounds();
  return { x: c.x + vp.x, y: c.y + vp.y, width: vp.width, height: vp.height };
}

// Is the OS cursor currently inside `r` (screen coords)? Drives the drop hint and
// the re-dock decision while a torn-off window is dragged.
function cursorInRect(r: Rect | null): boolean {
  if (!r) return false;
  const p = screen.getCursorScreenPoint();
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

function sendMain(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

const cursorOverDock = (): boolean => cursorInRect(toScreenRect(dockViewportRect));
const setDockHint = (active: boolean): void => sendMain('narukami:dockhint', active);
// Hand a torn-off terminal back to the main window (re-dock). Idempotent on the
// renderer side, so calling it from both the drop and the close path is safe.
const reclaim = (runId: string): void => sendMain('narukami:reclaim', runId);

const cursorOverBrowser = (): boolean => cursorInRect(toScreenRect(browserDockRect));
const setBrowserHint = (active: boolean): void => sendMain('narukami:browser-dockhint', active);
const reclaimBrowser = (projectId: string): void => sendMain('narukami:browser-reclaim', projectId);

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
      // Enable <webview> so the Browser view can embed the running app at many
      // viewports (out-of-process frames that ignore X-Frame-Options).
      webviewTag: true,
    },
  });
  win.setMenuBarVisibility(false);
  // Open external links in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
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
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  popouts.set(runId, win);
  windowRunId.set(win.id, runId);

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
 * Tear the whole Browser view off into its own window. The board is stateless
 * (a URL + viewport selection persisted per project), so the window just loads
 * the SPA with `?popout=browser&project=<id>` and renders the board full-window.
 * The main view shows a placeholder meanwhile; dragging this window back over it
 * — or closing it — re-docks the Browser view.
 */
function createBrowserWindow(projectId: string, pos?: { x: number; y: number }): void {
  const existing = browserPopouts.get(projectId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 480,
    minHeight: 360,
    ...(pos ? { x: Math.round(pos.x - 80), y: Math.round(pos.y - 12) } : {}),
    backgroundColor: '#0a0a0c',
    title: 'NARUKAMI — browser',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // the board embeds the app at each viewport
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  browserPopouts.set(projectId, win);

  let redocked = false;
  win.on('move', () => setBrowserHint(cursorOverBrowser()));
  win.on('moved', () => {
    if (cursorOverBrowser()) {
      redocked = true;
      setBrowserHint(false);
      reclaimBrowser(projectId);
      win.close();
    } else {
      setBrowserHint(false);
    }
  });
  win.on('closed', () => {
    browserPopouts.delete(projectId);
    if (!redocked) reclaimBrowser(projectId);
    setBrowserHint(false);
  });

  void win.loadURL(`${appUrl}?popout=browser&project=${encodeURIComponent(projectId)}`);
}

/**
 * Open ONE device viewport of a browser tab in its own full-window view. Mirror
 * semantics — the viewport stays in the board; this is an additional window. Many
 * can coexist (keyed by project+browser+viewport); re-invoking the same one just
 * focuses it. No drag-back/redock: these are throwaway preview windows, closed to
 * dismiss.
 */
function createViewportWindow(
  projectId: string,
  browserId: string,
  vpId: string,
  pos?: { x: number; y: number },
): void {
  const wkey = viewportPopoutKey(projectId, browserId, vpId);
  const existing = viewportPopouts.get(wkey);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 320,
    minHeight: 320,
    ...(pos ? { x: Math.round(pos.x - 80), y: Math.round(pos.y - 12) } : {}),
    backgroundColor: '#0a0a0c',
    title: 'NARUKAMI — viewport',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // renders the app at one device viewport
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  viewportPopouts.set(wkey, win);
  win.on('closed', () => viewportPopouts.delete(wkey));

  const qs =
    `?popout=viewport&project=${encodeURIComponent(projectId)}` +
    `&browser=${encodeURIComponent(browserId)}&vp=${encodeURIComponent(vpId)}`;
  void win.loadURL(`${appUrl}${qs}`);
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

// Parse a reported drop-zone rect (viewport coords) — null unless it's a real,
// positive-area rectangle.
function parseRect(rect: unknown): Rect | null {
  if (!rect || typeof rect !== 'object' || !('width' in rect)) return null;
  const r = rect as Rect;
  return r.width > 0 && r.height > 0
    ? { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) }
    : null;
}

// The main window reports its terminal dock's rectangle (viewport coordinates)
// whenever the layout changes, so drag-back drop detection knows the target.
ipcMain.on('narukami:dockrect', (_e, rect: unknown) => {
  dockViewportRect = parseRect(rect);
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

// --- Browser view tear-off ---
ipcMain.on('narukami:browser-popout', (_e, projectId: unknown, pos: unknown) => {
  if (typeof projectId !== 'string' || !projectId) return;
  const p =
    pos && typeof pos === 'object' && 'x' in pos && 'y' in pos
      ? { x: Number((pos as { x: number }).x), y: Number((pos as { y: number }).y) }
      : undefined;
  createBrowserWindow(projectId, p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : undefined);
});

// "Bring back" from the main window's placeholder — close the torn-off window,
// which re-docks via its close handler.
ipcMain.on('narukami:browser-bringback', (_e, projectId: unknown) => {
  if (typeof projectId !== 'string') return;
  const win = browserPopouts.get(projectId);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.on('narukami:browser-dockrect', (_e, rect: unknown) => {
  browserDockRect = parseRect(rect);
});

// --- Per-viewport pop-out (one device → its own window; many can coexist) ---
ipcMain.on('narukami:viewport-popout', (_e, params: unknown) => {
  const p = parseViewportPopoutParams(params);
  if (!p) return;
  createViewportWindow(p.projectId, p.browserId, p.vpId, p.pos);
});

// Restart the whole app. Used when toggling "phone access" (LAN sharing): that
// changes the backend's network bind (127.0.0.1 ⇄ 0.0.0.0), which is decided at
// startup, so a clean relaunch is the simplest way to apply it.
ipcMain.on('narukami:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

app.whenReady().then(async () => {
  try {
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
