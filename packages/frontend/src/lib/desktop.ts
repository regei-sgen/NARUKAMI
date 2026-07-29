// Bridge injected by the Electron preload (packages/desktop/src/preload.ts).
// Absent when running as a plain browser tab (dev), so callers use it to gate
// desktop-only affordances like popping a terminal into its own window.
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// One console or network event captured from the Browser view's preview
// iframes by the desktop shell (CDP). Discriminated on `kind`.
export type PreviewLogEvent =
  | { kind: 'console'; level: string; text: string }
  | { kind: 'net'; id: string; method: string; url: string; rtype: string }
  | { kind: 'netdone'; id: string; status: number; mime: string }
  | { kind: 'netfail'; id: string; error: string };

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
  // Browser view: start/stop CDP console+network capture for a preview URL's
  // origin. Optional — absent in shells built before this feature.
  previewWatch?: (url: string | null) => void;
  onPreviewLog?: (cb: (evt: PreviewLogEvent) => void) => () => void;
  // Real window visibility (minimize/restore) forwarded from the main process.
  // The shell disables background throttling, which pins the Page Visibility
  // API to 'visible' — this is the only trustworthy hidden/shown signal.
  // Optional — absent in shells built before this feature.
  onVisibility?: (cb: (hidden: boolean) => void) => () => void;
}

export function desktop(): NarukamiBridge | null {
  return (window as unknown as { narukami?: NarukamiBridge }).narukami ?? null;
}

// The runId this window was opened to display on its own, or null for the main
// app window. Set via the `?popout=<runId>` query the pop-out window loads with.
export function popoutRunId(): string | null {
  return new URLSearchParams(window.location.search).get('popout');
}
