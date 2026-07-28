import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
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

/** The PC Stats window is the app's own URL with this marker. */
const STATS_MARK = 'pcstats=1';

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Size + place the PC Stats window RELATIVE TO THE DISPLAY it will open on, so
 * it works on a 13" laptop and a 4K panel alike: a fraction of the work area,
 * clamped to sane bounds, and never larger than the screen it lands on. Placed
 * in the work area's top-right, inset, so it doesn't cover the main window's
 * header.
 */
function statsWindowBounds(): { width: number; height: number; x: number; y: number } {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const width = Math.round(clamp(workArea.width * 0.26, 320, 560));
  const height = Math.round(clamp(workArea.height * 0.62, 360, 820));
  // Fit before placing: on a small/scaled display the clamp floor could still
  // exceed the work area.
  const w = Math.min(width, workArea.width - 16);
  const h = Math.min(height, workArea.height - 16);
  return {
    width: w,
    height: h,
    x: Math.round(workArea.x + workArea.width - w - 24),
    y: Math.round(workArea.y + 24),
  };
}

function isStatsUrl(url: string): boolean {
  try {
    return new URL(url).search.includes(STATS_MARK);
  } catch {
    return false;
  }
}

interface Bounds {
  width: number;
  height: number;
  x: number;
  y: number;
}

const statsBoundsFile = (): string => path.join(app.getPath('userData'), 'pcstats-window.json');

/**
 * Remember where the user parked the stats window — it is a utility readout
 * people place deliberately (a strip across the top of a portrait monitor, a
 * corner of the main screen), and re-centring it on every open would undo that.
 */
function saveStatsBounds(win: BrowserWindow): void {
  try {
    if (win.isDestroyed() || win.isMinimized()) return;
    fs.writeFileSync(statsBoundsFile(), JSON.stringify(win.getBounds()));
  } catch {
    /* placement is a nicety — never let it break the window */
  }
}

/**
 * Restore saved bounds ONLY if they still land on a display that exists: a
 * window remembered on an unplugged monitor would otherwise reopen off-screen
 * and be unreachable. Requires a real overlap, not just a corner touch.
 */
function restoredStatsBounds(): Bounds | null {
  let saved: Partial<Bounds>;
  try {
    saved = JSON.parse(fs.readFileSync(statsBoundsFile(), 'utf8')) as Partial<Bounds>;
  } catch {
    return null;
  }
  const { x, y, width, height } = saved;
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const b = { x, y, width, height } as Bounds;
  if (b.width < 200 || b.height < 140) return null;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const overlapX = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const overlapY = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return overlapX > 80 && overlapY > 60;
  });
  return visible ? b : null;
}

/** The one PC Stats window. Kept module-level so every entry point reuses it. */
let statsWin: BrowserWindow | null = null;

/**
 * Open (or focus) the PC Stats window. Single owner of that window's creation —
 * the header chip's window.open and the tray both route here, so there is
 * exactly one set of options and one reuse rule.
 */
function openStatsWindow(): void {
  if (statsWin && !statsWin.isDestroyed()) {
    if (statsWin.isMinimized()) statsWin.restore();
    statsWin.show();
    statsWin.focus();
    return;
  }
  if (!appUrl) return; // backend not up yet — nothing to load
  statsWin = new BrowserWindow({
    // where the user last left it, else sized to the display it opens on
    ...(restoredStatsBounds() ?? statsWindowBounds()),
    minWidth: 240,
    minHeight: 260,
    title: 'NARUKAMI · PC Stats',
    backgroundColor: '#08080a',
    autoHideMenuBar: true,
    alwaysOnTop: true, // opens pinned; the in-window PIN button toggles it
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  statsWin.setMenuBarVisibility(false);
  void statsWin.loadURL(`${appUrl}/?${STATS_MARK}`);
  const remember = (): void => {
    if (statsWin) saveStatsBounds(statsWin);
  };
  statsWin.on('moved', remember);
  statsWin.on('resized', remember);
  statsWin.on('close', remember); // 'close' still has live bounds; 'closed' does not
  statsWin.on('closed', () => {
    statsWin = null;
  });
}

/** Show/focus the main window (tray "Open NARUKAMI"). */
function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows().find((w) => w !== statsWin && !w.isDestroyed());
  if (!win) {
    void createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Tray icon path. Mirrors resolvePaths(): in dev the source PNG in build/, in
 * the packaged app the copy stage.mjs places next to main.js inside the asar.
 */
function trayIconPath(): string {
  return PACKAGED
    ? path.join(__dirname, 'tray-icon.png')
    : path.join(__dirname, '..', 'build', 'icon.png');
}

// Module-level: a Tray that gets garbage collected disappears from the tray.
let tray: Tray | null = null;

interface StatsLanInfo {
  port: number;
  token: string;
  urls: string[];
}
interface StatsLanModule {
  startStatsLan: (port?: number, frontendDir?: string) => Promise<StatsLanInfo>;
  stopStatsLan: () => Promise<void>;
  isStatsLanRunning: () => boolean;
  statsLanInfo: () => StatsLanInfo | null;
}

/**
 * The read-only phone stats listener, loaded straight out of the compiled
 * backend. The backend runs IN THIS PROCESS, so requiring the module here
 * returns the very same instance the /api/pcstats/lan routes use — the tray and
 * the in-app control can never disagree about whether it's running.
 */
function statsLan(): StatsLanModule | null {
  try {
    const { backendIndex } = resolvePaths();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path.join(path.dirname(backendIndex), 'services', 'statsLan.js')) as StatsLanModule;
  } catch (err) {
    process.stderr.write(`[narukami] phone server module unavailable: ${String(err)}\n`);
    return null;
  }
}

/**
 * The address to type into the phone app. The NATIVE app takes the base URL and
 * the token as two separate fields, so this is the plain server address — not
 * the old `?pcstats=1&token=…` link the WebView build used.
 */
const phoneAddress = (info: StatsLanInfo): string => info.urls[0] ?? `http://localhost:${info.port}`;

/**
 * Show the address and token, with a copy button for each. Re-shown after a
 * copy so both values can be taken without reopening the dialog from the tray.
 */
function showPhoneAddress(info: StatsLanInfo, copied?: 'address' | 'token'): void {
  const addr = phoneAddress(info);
  const others = info.urls.slice(1);

  void dialog
    .showMessageBox({
      type: 'info',
      title: 'NARUKAMI · phone server',
      message: copied ? `${copied === 'address' ? 'Address' : 'Token'} copied.` : 'Read-only stats server is on.',
      detail:
        'In PC Stats on the phone, choose "Set server…" and enter:\n\n' +
        `ADDRESS   ${addr}\n` +
        `TOKEN     ${info.token}\n` +
        (others.length ? `\nOther addresses on this PC:\n${others.join('\n')}\n` : '') +
        '\nIt serves the stats and nothing else — no terminals, no file access. ' +
        'The token changes each time the server restarts.',
      buttons: ['Copy address', 'Copy token', 'Close'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === 0) {
        clipboard.writeText(addr);
        showPhoneAddress(info, 'address');
      } else if (response === 1) {
        clipboard.writeText(info.token);
        showPhoneAddress(info, 'token');
      }
    });
}

/** Turn the phone server on/off from the tray, then refresh the menu's state. */
async function togglePhoneServer(): Promise<void> {
  const mod = statsLan();
  if (!mod) return;
  try {
    if (mod.isStatsLanRunning()) {
      await mod.stopStatsLan();
    } else {
      const { frontendDir } = resolvePaths();
      showPhoneAddress(await mod.startStatsLan(4311, frontendDir));
    }
  } catch (err) {
    dialog.showErrorBox('Phone server failed', String((err as Error)?.message ?? err));
  }
  buildTrayMenu();
}

/**
 * The NARUKAMI tray controller: quick access to the PC Stats window without
 * going through the main window at all. Left-click opens the stats readout
 * directly — that is the one thing you usually want from the tray.
 */
/**
 * Build the tray menu from the CURRENT state.
 *
 * Deliberately rebuilt on every right-click rather than set once: the phone
 * server can also be toggled from the stats window (or stopped by an API call),
 * and a menu pinned with setContextMenu would keep showing a stale checkbox and
 * tooltip.
 */
function trayMenu(): Menu {
  const mod = statsLan();
  const running = mod?.isStatsLanRunning() ?? false;
  const info = running ? mod?.statsLanInfo() ?? null : null;

  tray?.setToolTip(running ? 'NARUKAMI — phone server ON' : 'NARUKAMI — PC stats & controls');

  return Menu.buildFromTemplate([
    { label: 'PC Stats', click: () => openStatsWindow() },
    { label: 'Open NARUKAMI', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: running ? 'Phone server (Wi-Fi) — ON' : 'Phone server (Wi-Fi)',
      type: 'checkbox',
      checked: running,
      enabled: mod !== null,
      click: () => void togglePhoneServer(),
    },
    {
      label: info ? `Show phone address · :${info.port}` : 'Show phone address',
      enabled: running && info !== null,
      click: () => {
        if (info) showPhoneAddress(info);
      },
    },
    {
      label: 'Copy address',
      enabled: running && info !== null,
      click: () => {
        if (info) clipboard.writeText(phoneAddress(info));
      },
    },
    {
      label: 'Copy token',
      enabled: running && info !== null,
      click: () => {
        if (info) clipboard.writeText(info.token);
      },
    },
    { type: 'separator' },
    { label: 'Quit NARUKAMI', click: () => app.quit() },
  ]);
}

/**
 * Install the menu natively.
 *
 * setContextMenu (rather than handling 'right-click' + popUpContextMenu) is
 * what the Windows 11 shell honours for an icon living in the overflow flyout —
 * the right-click event does not reliably reach the app there, so a popUp-based
 * menu simply never appeared. Freshness is handled by re-installing it on
 * hover and after every toggle instead.
 */
function buildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(trayMenu());
}

function createTray(): void {
  const src = nativeImage.createFromPath(trayIconPath());
  if (src.isEmpty()) {
    process.stderr.write(`[narukami] tray icon missing at ${trayIconPath()} — tray not created\n`);
    return;
  }
  tray = new Tray(src.resize({ width: 16, height: 16 }));
  buildTrayMenu();
  tray.on('click', () => openStatsWindow());
  // Re-install just before the user can open it, so the phone-server checkbox
  // reflects a toggle made from the stats window rather than the tray.
  tray.on('mouse-enter', () => buildTrayMenu());
  tray.on('mouse-move', () => buildTrayMenu());
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
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      // Never throttle the renderer when minimized/occluded: live terminals
      // keep streaming, and a throttled renderer would stall xterm writes and
      // idle/activity timers, then burst-replay them on restore (visible lag).
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The PC Stats window is our OWN page: open it as a real, pinnable child
    // window sized to whatever display it lands on. Everything else is an
    // external link and goes to the system browser, never in-app.
    if (isStatsUrl(url)) {
      // Deny the browser-made popup and open OUR window instead, so the header
      // chip and the tray share one implementation (and one reuse rule).
      openStatsWindow();
      return { action: 'deny' };
    }
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

// Pin toggle for the PC Stats window. Scoped to the CALLING window, so a
// renderer can only ever pin itself — not reach across to another window.
ipcMain.handle('window:set-always-on-top', (event, flag: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const on = Boolean(flag);
  win.setAlwaysOnTop(on);
  return on;
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  try {
    appUrl = await startBackend();
    const win = await createWindow();
    createTray();
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
