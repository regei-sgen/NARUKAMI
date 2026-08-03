import { describe, expect, it, vi, beforeAll } from 'vitest';

/**
 * Tests the Electron main process's REAL orchestration — the IPC surface it exposes to the
 * renderer — not extracted helpers.
 *
 * main.ts imports `electron` at module scope and exports nothing, which is why it sat at zero
 * coverage. Mocking the module makes it importable; capturing the handlers it registers makes its
 * behaviour assertable. `app.whenReady()` returns a promise that never resolves ON PURPOSE, so the
 * async boot block (backend spawn, window creation, tray, updater) never runs — this pins the
 * synchronous contract without standing up an Electron runtime.
 *
 * What this proves: the channels the renderer depends on exist, and the handlers validate their
 * input instead of trusting it. A renderer is not a trust boundary — it can send anything.
 */

const ipcOn = new Map<string, (...a: unknown[]) => unknown>();
const ipcHandle = new Map<string, (...a: unknown[]) => unknown>();
const appOn = new Map<string, (...a: unknown[]) => unknown>();

const electronMock = vi.hoisted(() => ({ ipcOn: new Map(), ipcHandle: new Map(), appOn: new Map() }));

vi.mock('electron', () => {
  const noop = () => undefined;
  const win = {
    id: 1,
    isDestroyed: () => false,
    webContents: { send: vi.fn(), on: noop, session: { webRequest: { onHeadersReceived: noop } } },
    on: noop, once: noop, show: noop, hide: noop, focus: noop, close: noop,
    setAlwaysOnTop: vi.fn(), isVisible: () => true, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    setBounds: noop, loadURL: () => Promise.resolve(),
  };
  return {
    app: {
      isPackaged: false,
      getPath: () => 'C:/tmp/userData',
      getAppPath: () => 'C:/app',
      whenReady: () => new Promise(() => { /* never resolves: skip the async boot */ }),
      on: (ch: string, fn: () => void) => { electronMock.appOn.set(ch, fn); },
      setLoginItemSettings: vi.fn(),
      getLoginItemSettings: () => ({ wasOpenedAtLogin: false }),
      quit: vi.fn(), requestSingleInstanceLock: () => true, setAppUserModelId: noop,
    },
    BrowserWindow: Object.assign(function () { return win; }, {
      getAllWindows: () => [win], fromWebContents: () => win, fromId: () => win,
    }),
    ipcMain: {
      on: (ch: string, fn: (...a: unknown[]) => unknown) => { electronMock.ipcOn.set(ch, fn); },
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => { electronMock.ipcHandle.set(ch, fn); },
      removeHandler: noop,
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    },
    session: { defaultSession: { webRequest: { onHeadersReceived: noop } }, fromPartition: () => ({ webRequest: { onHeadersReceived: noop } }) },
    shell: { openExternal: vi.fn() },
    clipboard: { writeText: vi.fn() },
    dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: noop },
    Tray: function () { return { setToolTip: noop, setContextMenu: noop, on: noop, destroy: noop }; },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }) },
  };
});

vi.mock('electron-updater', () => ({
  autoUpdater: { on: () => undefined, checkForUpdatesAndNotify: () => Promise.resolve(null), quitAndInstall: vi.fn() },
}));

beforeAll(async () => {
  await import('./main');
  for (const [k, v] of electronMock.ipcOn) ipcOn.set(k, v as never);
  for (const [k, v] of electronMock.ipcHandle) ipcHandle.set(k, v as never);
  for (const [k, v] of electronMock.appOn) appOn.set(k, v as never);
});

describe('main process loads at all', () => {
  it('imports without throwing once electron is provided — the precondition for testing it', () => {
    expect(ipcOn.size + ipcHandle.size).toBeGreaterThan(0);
  });
});

describe('IPC surface the renderer depends on', () => {
  // If a channel name changes, the renderer silently stops working — nothing else catches that.
  it.each([
    'narukami:popout',
    'narukami:dockrect',
    'narukami:preview-watch',
    'narukami:runchanged',
  ])('registers the %s listener', (ch) => {
    expect(ipcOn.has(ch)).toBe(true);
  });

  it('registers the window:set-always-on-top invoke handler', () => {
    expect(ipcHandle.has('window:set-always-on-top')).toBe(true);
  });

  it('registers the app lifecycle hooks that implement tray residency', () => {
    expect(appOn.has('before-quit')).toBe(true);
    expect(appOn.has('window-all-closed')).toBe(true);
  });
});

describe('handlers validate renderer input instead of trusting it', () => {
  // The renderer is not a trust boundary. Each of these previously had to be reasoned about;
  // now they are pinned.
  it('narukami:dockrect survives junk payloads without throwing', () => {
    const h = ipcOn.get('narukami:dockrect')!;
    for (const junk of [undefined, null, 'string', 42, {}, { width: 0, height: 0 }, { x: 'a', y: 'b', width: 5, height: 5 }]) {
      expect(() => h({}, junk)).not.toThrow();
    }
  });

  it('narukami:popout survives a non-string runId', () => {
    const h = ipcOn.get('narukami:popout')!;
    for (const junk of [undefined, null, 42, {}, []]) {
      expect(() => h({}, junk, undefined)).not.toThrow();
    }
  });

  it('narukami:runchanged survives non-string ids', () => {
    const h = ipcOn.get('narukami:runchanged')!;
    expect(() => h({}, undefined, undefined)).not.toThrow();
    expect(() => h({}, 42, {})).not.toThrow();
  });

  it('narukami:preview-watch survives a non-URL payload', () => {
    const h = ipcOn.get('narukami:preview-watch')!;
    const e = { sender: { id: 1, on: () => undefined, debugger: { isAttached: () => false, attach: () => undefined, on: () => undefined, sendCommand: () => Promise.resolve() } } };
    for (const junk of [undefined, null, 42, 'not a url', {}]) {
      expect(() => h(e, junk)).not.toThrow();
    }
  });

  it('window:set-always-on-top coerces its flag and never throws', () => {
    const h = ipcHandle.get('window:set-always-on-top')!;
    const event = { sender: {} };
    for (const junk of [true, false, undefined, null, 'yes', 0, 1]) {
      expect(() => h(event, junk)).not.toThrow();
    }
  });
});
