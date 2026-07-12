// Pure helpers for the Browser view (responsive multi-viewport preview), kept
// out of the component so the URL / scaling / viewport-selection logic can be
// unit-tested without a DOM.

// Normalize a user-typed address into a loadable URL: empty → '' (nothing to
// load), a bare host[:port][/path] gets an http:// scheme, and existing http(s)
// URLs pass through untouched. Surrounding whitespace is trimmed.
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `http://${s}`;
}

// The on-screen geometry of one device viewport scaled to fit `targetW` px wide.
// Never upscales past 1:1, so small viewports (mobile) render at real size.
export interface FrameSize {
  scale: number;
  dispW: number;
  dispH: number;
}
export function frameSize(vpW: number, vpH: number, targetW: number): FrameSize {
  const scale = Math.min(1, targetW / vpW);
  return { scale, dispW: Math.round(vpW * scale), dispH: Math.round(vpH * scale) };
}

// Scale one viewport to fill an available box (both dimensions) while keeping
// aspect ratio — used by the full-window single-viewport popout. Unlike
// frameSize this MAY upscale, so a small mobile viewport still fills the window.
export function fitScale(vpW: number, vpH: number, availW: number, availH: number): FrameSize {
  const scale = Math.max(0.05, Math.min(availW / vpW, availH / vpH));
  return { scale, dispW: Math.round(vpW * scale), dispH: Math.round(vpH * scale) };
}

// Full geometry for one rendered device frame. `dispW`/`dispH` are the on-screen
// (post-scale) box; `frameW`/`frameH` are the intrinsic size the page renders at
// (the real viewport), then CSS-scaled by `scale` to the display box. Splitting
// the intrinsic size from the display size lets "fill" mode render a page TALLER
// than the device preset so it fills the panel and scrolls like a real browser.
export interface FrameLayout {
  scale: number;
  dispW: number;
  dispH: number;
  frameW: number;
  frameH: number;
}

// Width-driven: render at the device's native size, scaled so its WIDTH fits
// `targetW`. Never upscales (small viewports stay crisp at 1:1).
export function layoutByWidth(vpW: number, vpH: number, targetW: number): FrameLayout {
  const scale = Math.min(1, targetW / vpW);
  return { scale, dispW: Math.round(vpW * scale), dispH: Math.round(vpH * scale), frameW: vpW, frameH: vpH };
}

// Height-driven: render at the device's native size, scaled so its HEIGHT fits
// `targetH`. Used by the grid so every device shows at the same on-screen height.
// Never upscales.
export function layoutByHeight(vpW: number, vpH: number, targetH: number): FrameLayout {
  const scale = Math.min(1, targetH / vpH);
  return { scale, dispW: Math.round(vpW * scale), dispH: Math.round(vpH * scale), frameW: vpW, frameH: vpH };
}

// Fill mode (single device, real-browser feel): keep the device WIDTH accurate
// (scaled down only when the device is wider than the panel — never upscaled) and
// stretch the page to FILL the panel height. The page renders taller than the
// device preset and scrolls inside the frame, exactly like a real browser tab.
export function layoutFill(vpW: number, availW: number, availH: number): FrameLayout {
  const scale = Math.min(1, availW / vpW);
  const dispW = Math.round(vpW * scale);
  const dispH = Math.max(1, Math.round(availH));
  const frameH = Math.max(1, Math.round(availH / scale));
  return { scale, dispW, dispH, frameW: vpW, frameH };
}

// Fit-both, no upscale: scale a device to fit a box on BOTH axes, capped at 1:1
// (a small device shows at native size rather than a blurry upscale). Used by the
// single-viewport pop-out window so one device fills as much of the window as it
// can without stretching.
export function layoutFit(vpW: number, vpH: number, availW: number, availH: number): FrameLayout {
  const scale = Math.min(1, availW / vpW, availH / vpH);
  return { scale, dispW: Math.round(vpW * scale), dispH: Math.round(vpH * scale), frameW: vpW, frameH: vpH };
}

// Device presets shown in the responsive board. `w`/`h` are CSS pixels — the
// page renders at that real viewport, then it's visually scaled to fit.
export interface Viewport {
  id: string;
  name: string;
  w: number;
  h: number;
}
export const VIEWPORTS: Viewport[] = [
  { id: 'mobile', name: 'Mobile', w: 375, h: 812 },
  { id: 'tablet', name: 'Tablet', w: 768, h: 1024 },
  { id: 'laptop', name: 'Laptop', w: 1280, h: 800 },
  { id: 'desktop', name: 'Desktop', w: 1440, h: 900 },
  { id: 'wide', name: 'Wide', w: 1920, h: 1080 },
];
export const VIEWPORT_IDS = VIEWPORTS.map((v) => v.id);
export const DEFAULT_ENABLED = ['mobile', 'tablet', 'desktop'];
export function viewportById(id: string): Viewport | undefined {
  return VIEWPORTS.find((v) => v.id === id);
}

// Parse a persisted comma-separated viewport-id list, dropping ids that are no
// longer valid presets and falling back to `defaults` when nothing usable
// remains (missing/empty storage, or every saved id gone stale).
export function parseEnabled(
  saved: string | null,
  validIds: string[],
  defaults: string[],
): string[] {
  const ids = saved ? saved.split(',').filter((id) => validIds.includes(id)) : [];
  return ids.length ? ids : defaults;
}

export const DEFAULT_URL = 'http://localhost:3000';

// Browser identities to emulate. Everything renders in Chromium (Electron), but
// the webview reports the chosen User-Agent, so sites behave/branch as in that
// browser. Chrome/Edge/Brave/Opera really ARE Chromium; Safari/Firefox UA is an
// emulation (behaviour, not a true engine swap).
export interface BrowserEngine {
  id: string;
  name: string;
  ua: string;
}
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const BROWSER_ENGINES: BrowserEngine[] = [
  { id: 'chrome', name: 'Chrome', ua: CHROME_UA },
  { id: 'edge', name: 'Edge', ua: `${CHROME_UA} Edg/126.0.0.0` },
  { id: 'brave', name: 'Brave', ua: CHROME_UA }, // Brave deliberately reports plain Chrome
  { id: 'opera', name: 'Opera', ua: `${CHROME_UA} OPR/112.0.0.0` },
  {
    id: 'safari',
    name: 'Safari',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  },
  {
    id: 'safari-ios',
    name: 'Safari (iOS)',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
  {
    id: 'firefox',
    name: 'Firefox',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  },
];
export const ENGINE_IDS = BROWSER_ENGINES.map((e) => e.id);
export const DEFAULT_ENGINE = 'chrome';
export function engineUa(id: string): string {
  return (BROWSER_ENGINES.find((e) => e.id === id) ?? BROWSER_ENGINES[0]).ua;
}

// Which real Playwright engine (if any) backs an emulated browser id for the
// real-render mode. Chromium-family ids return null: they already render
// natively in the app's own webview, so there's nothing extra to launch. Mirror
// of the backend's resolveRenderEngine (kept in sync by their shared tests).
export type RenderEngine = 'firefox' | 'webkit';
export function renderEngineFor(id: string): RenderEngine | null {
  if (id === 'firefox') return 'firefox';
  if (id === 'safari' || id === 'safari-ios') return 'webkit';
  return null;
}

// One browser instance in a project's Browser view: its own URL + viewport set +
// emulated browser identity.
export interface BrowserTab {
  id: string;
  name: string;
  url: string;
  viewports: string[];
  engine: string;
}

// Build a project's browser-tab list from persisted state, tolerating anything:
// - a valid stored tab array → sanitized (fill missing/invalid fields),
// - malformed JSON or an empty array → migrate the legacy single board
//   (`legacyUrl`/`legacyVps` keys) into one tab, or seed a default.
// `genId` supplies ids for tabs missing one (injected so tests stay deterministic).
export function normalizeTabs(
  rawJson: string | null,
  legacyUrl: string | null,
  legacyVps: string | null,
  validIds: string[],
  defaults: string[],
  genId: () => string,
): BrowserTab[] {
  if (rawJson) {
    try {
      const parsed: unknown = JSON.parse(rawJson);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map((raw): BrowserTab => {
          const b = (raw ?? {}) as Partial<BrowserTab>;
          return {
            id: typeof b.id === 'string' && b.id ? b.id : genId(),
            name: typeof b.name === 'string' && b.name ? b.name : 'Browser',
            url: typeof b.url === 'string' && b.url ? b.url : DEFAULT_URL,
            viewports: parseEnabled(
              Array.isArray(b.viewports) ? b.viewports.join(',') : null,
              validIds,
              defaults,
            ),
            engine: typeof b.engine === 'string' && ENGINE_IDS.includes(b.engine) ? b.engine : DEFAULT_ENGINE,
          };
        });
      }
    } catch {
      /* malformed — fall through to migrate/seed */
    }
  }
  return [
    {
      id: genId(),
      name: 'Browser 1',
      url: legacyUrl ?? DEFAULT_URL,
      viewports: parseEnabled(legacyVps, validIds, defaults),
      engine: DEFAULT_ENGINE,
    },
  ];
}

// Remove a browser tab by id (the caller keeps at least one).
export function closeBrowser(list: BrowserTab[], id: string): BrowserTab[] {
  return list.filter((b) => b.id !== id);
}

// Which tab should be active after `removedId` is closed from `list` (the list
// BEFORE removal). Keep the current active if it survived; otherwise fall to the
// tab that slides into the closed one's slot (the next tab, or the previous if
// the closed tab was last).
export function pickActive(list: BrowserTab[], removedId: string, currentActive: string): string {
  if (currentActive !== removedId) return currentActive;
  const idx = list.findIndex((b) => b.id === removedId);
  const remaining = list.filter((b) => b.id !== removedId);
  if (remaining.length === 0) return currentActive; // caller prevents emptiness
  return remaining[Math.min(idx, remaining.length - 1)].id;
}
