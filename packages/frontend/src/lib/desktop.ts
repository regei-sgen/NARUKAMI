// Bridge injected by the Electron preload (packages/desktop/src/preload.ts).
// Absent when running as a plain browser tab (dev), so callers use it to gate
// desktop-only affordances like popping a terminal into its own window.
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NarukamiBridge {
  // Tear a terminal off into its own window (it leaves the current window). `pos`
  // is the cursor in screen coordinates so the shell spawns the window there.
  popOut: (runId: string, pos?: { x: number; y: number }) => void;
  // A torn-off window that restarted its run announces the re-key so the shell
  // re-docks the right runId.
  signalRunChanged: (oldRunId: string, newRunId: string) => void;
  // Main window: report the terminal dock's rect (viewport coords) for drag-back
  // drop detection. Pass null when there's no dock.
  reportDockRect: (rect: Rect | null) => void;
  // Main window: a torn-off terminal is being re-docked — re-add its tab.
  onReclaim: (cb: (runId: string) => void) => () => void;
  // Main window: toggle the dock's drop highlight during a drag-back.
  onDockHint: (cb: (active: boolean) => void) => () => void;

  // --- Browser view tear-off (the whole responsive board → its own window) ---
  // Tear the Browser view off into its own window (leaves the main view). `pos`
  // is the cursor in screen coordinates so the shell spawns it there.
  popOutBrowser: (projectId: string, pos?: { x: number; y: number }) => void;
  // Ask the shell to close the torn-off Browser window (the "bring back" button).
  bringBackBrowser: (projectId: string) => void;
  // Main window: report the Browser drop zone's rect (viewport coords) for
  // drag-back detection; null when there's no drop target.
  reportBrowserDockRect: (rect: Rect | null) => void;
  // Main window: the torn-off Browser is being re-docked — restore the view.
  onBrowserReclaim: (cb: (projectId: string) => void) => () => void;
  // Main window: toggle the Browser drop highlight during a drag-back.
  onBrowserDockHint: (cb: (active: boolean) => void) => () => void;

  // --- Per-viewport pop-out (one device → its own full-window view) ---
  // Open a single device viewport of a browser tab in its own window (mirror —
  // it stays in the board too). Many can be open at once, keyed by
  // project+browser+viewport; re-invoking the same one just focuses it. `pos` is
  // the cursor in screen coordinates for a drag-out.
  popOutViewport: (params: {
    projectId: string;
    browserId: string;
    vpId: string;
    pos?: { x: number; y: number };
  }) => void;

  // Restart the app — used when toggling phone/LAN sharing (the backend's network
  // bind is decided at startup).
  relaunch: () => void;
}

export function desktop(): NarukamiBridge | null {
  return (window as unknown as { narukami?: NarukamiBridge }).narukami ?? null;
}

// The runId this window was opened to display on its own, or null for the main
// app window. Set via the `?popout=<runId>` query the pop-out window loads with.
export function popoutRunId(): string | null {
  return new URLSearchParams(window.location.search).get('popout');
}
