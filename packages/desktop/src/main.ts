import { app, BrowserWindow, dialog, shell } from 'electron';
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
  await win.loadURL(appUrl);
  return win;
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
    appUrl = await startBackend();
    const win = await createWindow();
    setupAutoUpdate(win);
  } catch (err) {
    dialog.showErrorBox('NARUKAMI failed to start', String((err as Error)?.stack ?? err));
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
