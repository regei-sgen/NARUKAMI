import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

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

function setDockHint(active: boolean): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('narukami:dockhint', active);
  }
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
