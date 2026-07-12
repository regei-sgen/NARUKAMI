// Pure, dependency-free helpers for the Playwright real-render service, kept out
// of the service module so the engine mapping, viewport clamping, device-profile
// building and WS message protocol can be unit-tested without launching a
// browser (or even importing playwright).

export type RenderEngine = 'firefox' | 'webkit';

// Map a selectable browser id to a real Playwright engine, or null when the id
// is Chromium-family — those already render natively in the app's own webview,
// so there's nothing for Playwright to do (using it would be a pointless second
// Chromium). Safari desktop + iOS both map to real WebKit.
export function resolveRenderEngine(engineId: string): RenderEngine | null {
  if (engineId === 'firefox') return 'firefox';
  if (engineId === 'safari' || engineId === 'safari-ios') return 'webkit';
  return null;
}

export const RENDER_LIMITS = { minW: 200, maxW: 2560, minH: 200, maxH: 4096 } as const;

export function clampDim(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Real iOS Safari UA — applied (with mobile flags) when emulating Safari (iOS)
// on top of the real WebKit engine so sites branch and lay out as on an iPhone.
export const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

export interface DeviceProfile {
  width: number;
  height: number;
  /** Undefined => let Playwright use the engine's real default UA. */
  userAgent?: string;
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
}

// Build the browser-context profile for an engine id + requested viewport.
// Safari (iOS) emulates an iPhone (touch, DPR 3, iOS UA) on the real WebKit
// engine; desktop Safari and Firefox render at their real default UA. NOTE:
// isMobile is a WebKit/Chromium-only option — it must stay false for Firefox,
// which is guaranteed here because only 'safari-ios' turns it on.
export function deviceProfile(engineId: string, w: unknown, h: unknown): DeviceProfile {
  const ios = engineId === 'safari-ios';
  return {
    width: clampDim(w, RENDER_LIMITS.minW, RENDER_LIMITS.maxW),
    height: clampDim(h, RENDER_LIMITS.minH, RENDER_LIMITS.maxH),
    userAgent: ios ? IOS_UA : undefined,
    isMobile: ios,
    hasTouch: ios,
    deviceScaleFactor: ios ? 3 : 1,
  };
}

// Normalize a user-typed address into a loadable URL (mirror of the frontend's
// normalizeUrl): empty => '', bare host gets http://, http(s) passes through.
export function normalizeRenderUrl(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `http://${s}`;
}

// --- WS message protocol (client -> render service) ---------------------------

export interface OpenMsg {
  type: 'open';
  engineId: string;
  url: string;
  w: number;
  h: number;
}
export interface NavMsg {
  type: 'nav';
  url: string;
}
export interface ResizeMsg {
  type: 'resize';
  w: number;
  h: number;
}
export interface ReloadMsg {
  type: 'reload';
}
export type InputKind = 'click' | 'move' | 'scroll' | 'key' | 'text';
export interface InputMsg {
  type: 'input';
  kind: InputKind;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  key?: string;
  text?: string;
  button?: 'left' | 'right';
}
export interface CloseMsg {
  type: 'close';
}
export type RenderClientMsg = OpenMsg | NavMsg | ResizeMsg | ReloadMsg | InputMsg | CloseMsg;

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// Parse + validate a raw client frame. Returns null for anything malformed so a
// hostile or buggy client can never drive the Playwright page with junk.
export function parseRenderMsg(raw: unknown): RenderClientMsg | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRec(obj) || typeof obj.type !== 'string') return null;

  switch (obj.type) {
    case 'open': {
      if (typeof obj.engineId !== 'string' || typeof obj.url !== 'string') return null;
      return {
        type: 'open',
        engineId: obj.engineId,
        url: obj.url,
        w: clampDim(obj.w, RENDER_LIMITS.minW, RENDER_LIMITS.maxW),
        h: clampDim(obj.h, RENDER_LIMITS.minH, RENDER_LIMITS.maxH),
      };
    }
    case 'nav': {
      if (typeof obj.url !== 'string') return null;
      return { type: 'nav', url: obj.url };
    }
    case 'resize':
      return {
        type: 'resize',
        w: clampDim(obj.w, RENDER_LIMITS.minW, RENDER_LIMITS.maxW),
        h: clampDim(obj.h, RENDER_LIMITS.minH, RENDER_LIMITS.maxH),
      };
    case 'reload':
      return { type: 'reload' };
    case 'close':
      return { type: 'close' };
    case 'input': {
      const kind = obj.kind;
      if (kind !== 'click' && kind !== 'move' && kind !== 'scroll' && kind !== 'key' && kind !== 'text') {
        return null;
      }
      const msg: InputMsg = { type: 'input', kind };
      if (typeof obj.x === 'number') msg.x = obj.x;
      if (typeof obj.y === 'number') msg.y = obj.y;
      if (typeof obj.dx === 'number') msg.dx = obj.dx;
      if (typeof obj.dy === 'number') msg.dy = obj.dy;
      if (typeof obj.key === 'string') msg.key = obj.key;
      if (typeof obj.text === 'string') msg.text = obj.text;
      if (obj.button === 'left' || obj.button === 'right') msg.button = obj.button;
      return msg;
    }
    default:
      return null;
  }
}

// Clamp a forwarded pointer coordinate into the current viewport so a click can
// never land outside the page box.
export function clampPoint(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(0, x), w),
    y: Math.min(Math.max(0, y), h),
  };
}
