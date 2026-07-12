import { contextBridge, ipcRenderer } from 'electron';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Bridge exposed to the renderer as `window.narukami`. Its mere presence is how
// the SPA detects it's running inside the desktop shell (vs a plain browser tab
// in dev), so it only offers the tear-off affordances where they can work.
contextBridge.exposeInMainWorld('narukami', {
  // Tear a terminal off into its own window (move semantics). `pos` is the cursor
  // in screen coordinates at drop, so the shell can spawn the window there.
  popOut: (runId: string, pos?: { x: number; y: number }): void => {
    ipcRenderer.send('narukami:popout', runId, pos);
  },
  // Restart inside a torn-off window re-keys the run; keep the shell's mapping
  // current so the right runId is re-docked.
  signalRunChanged: (oldRunId: string, newRunId: string): void => {
    ipcRenderer.send('narukami:runchanged', oldRunId, newRunId);
  },
  // Main window: report the terminal dock's rectangle (viewport coordinates) so
  // the shell can detect a torn-off window being dragged back over it.
  reportDockRect: (rect: Rect | null): void => {
    ipcRenderer.send('narukami:dockrect', rect);
  },
  // Main window: a torn-off terminal is being handed back — re-add its tab.
  onReclaim: (cb: (runId: string) => void): (() => void) => {
    const handler = (_e: unknown, runId: string): void => cb(runId);
    ipcRenderer.on('narukami:reclaim', handler);
    return () => ipcRenderer.removeListener('narukami:reclaim', handler);
  },
  // Main window: toggle the dock's drop highlight while a window is dragged over it.
  onDockHint: (cb: (active: boolean) => void): (() => void) => {
    const handler = (_e: unknown, active: boolean): void => cb(active);
    ipcRenderer.on('narukami:dockhint', handler);
    return () => ipcRenderer.removeListener('narukami:dockhint', handler);
  },

  // --- Browser view tear-off ---
  popOutBrowser: (projectId: string, pos?: { x: number; y: number }): void => {
    ipcRenderer.send('narukami:browser-popout', projectId, pos);
  },
  bringBackBrowser: (projectId: string): void => {
    ipcRenderer.send('narukami:browser-bringback', projectId);
  },
  reportBrowserDockRect: (rect: Rect | null): void => {
    ipcRenderer.send('narukami:browser-dockrect', rect);
  },
  onBrowserReclaim: (cb: (projectId: string) => void): (() => void) => {
    const handler = (_e: unknown, projectId: string): void => cb(projectId);
    ipcRenderer.on('narukami:browser-reclaim', handler);
    return () => ipcRenderer.removeListener('narukami:browser-reclaim', handler);
  },
  onBrowserDockHint: (cb: (active: boolean) => void): (() => void) => {
    const handler = (_e: unknown, active: boolean): void => cb(active);
    ipcRenderer.on('narukami:browser-dockhint', handler);
    return () => ipcRenderer.removeListener('narukami:browser-dockhint', handler);
  },

  // --- Per-viewport pop-out ---
  popOutViewport: (params: {
    projectId: string;
    browserId: string;
    vpId: string;
    pos?: { x: number; y: number };
  }): void => {
    ipcRenderer.send('narukami:viewport-popout', params);
  },

  // Restart the app (used when toggling phone/LAN sharing, which rebinds the
  // backend's network interface at startup).
  relaunch: (): void => {
    ipcRenderer.send('narukami:relaunch');
  },
});
