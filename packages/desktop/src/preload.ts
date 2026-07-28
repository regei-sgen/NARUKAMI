import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge across contextIsolation. Deliberately tiny: the PC Stats
 * window needs to pin itself above other apps, which is a window-level power
 * the sandboxed renderer cannot have on its own. No general IPC is exposed.
 */
contextBridge.exposeInMainWorld('narukamiDesktop', {
  /** Pin/unpin THIS window above all other windows. Resolves to the new state. */
  setAlwaysOnTop: (flag: boolean): Promise<boolean> =>
    ipcRenderer.invoke('window:set-always-on-top', flag) as Promise<boolean>,
});
